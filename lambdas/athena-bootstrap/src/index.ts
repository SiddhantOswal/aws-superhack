import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';

const ATHENA_DB = process.env.ATHENA_DB || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || '';

if (!ATHENA_DB || !ATHENA_WORKGROUP) {
  // Fail fast during cold start to surface misconfiguration
  // eslint-disable-next-line no-console
  console.warn('ATHENA_DB and ATHENA_WORKGROUP must be set');
}

const athena = new AthenaClient({});

async function startAndWait(query: string): Promise<string> {
  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      QueryExecutionContext: { Database: ATHENA_DB },
      WorkGroup: ATHENA_WORKGROUP,
    }),
  );
  const id = start.QueryExecutionId!;

  // Poll for completion
  let state: QueryExecutionState | undefined;
  const started = Date.now();
  const timeoutMs = 5 * 60 * 1000; // 5 minutes
  while (true) {
    const exec = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    state = exec.QueryExecution?.Status?.State as QueryExecutionState | undefined;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      const reason = exec.QueryExecution?.Status?.StateChangeReason;
      throw new Error(`Athena query ${id} ${state}: ${reason}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Athena query ${id} timed out`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return id;
}

async function previewOne(viewName: string): Promise<void> {
  try {
    const q = `SELECT * FROM ${viewName} LIMIT 1`;
    const id = await startAndWait(q);
    const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 5 }));
    // eslint-disable-next-line no-console
    console.log(`Preview ${viewName}:`, JSON.stringify(res.ResultSet?.Rows?.[1]?.Data ?? []));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Preview failed for ${viewName}:`, (err as Error).message);
  }
}

function getQueries(): Array<{ name: string; sql: string }> {
  const scopeUsage = `
CREATE OR REPLACE VIEW scope_usage_vw AS
SELECT
  t.client_id,
  t.category,
  date_trunc('month', from_iso8601_timestamp(t.ticket_time)) AS month,
  sum(coalesce(t.billable_hours, 0)) AS total_billable_hours
FROM tickets t
GROUP BY t.client_id, t.category, date_trunc('month', from_iso8601_timestamp(t.ticket_time));`;

  const shelfware = `
CREATE OR REPLACE VIEW shelfware_vw AS
WITH usage AS (
  SELECT client_id, app, period, count_distinct(user_id) AS active_logins
  FROM logins
  GROUP BY client_id, app, period
)
SELECT
  l.client_id,
  l.app,
  l.period,
  l.seats AS licensed_seats,
  coalesce(u.active_logins, 0) AS active_logins,
  GREATEST(l.seats - coalesce(u.active_logins, 0), 0) AS reclaimable_seats,
  (GREATEST(l.seats - coalesce(u.active_logins, 0), 0) * coalesce(l.annual_price_per_seat, 0)) AS annual_saving
FROM licenses l
LEFT JOIN usage u ON u.client_id = l.client_id AND u.app = l.app AND u.period = l.period;`;

  const underbilling = `
CREATE OR REPLACE VIEW underbilling_vw AS
WITH time_by_period AS (
  SELECT client_id, period, sum(coalesce(amount, 0)) AS time_value
  FROM time_entries
  GROUP BY client_id, period
), invoices_by_period AS (
  SELECT client_id, period, sum(coalesce(amount, 0)) AS invoiced_value
  FROM invoices
  GROUP BY client_id, period
)
SELECT
  coalesce(t.client_id, i.client_id) AS client_id,
  coalesce(t.period, i.period) AS period,
  coalesce(t.time_value, 0) AS time_value,
  coalesce(i.invoiced_value, 0) AS invoiced_value,
  (coalesce(t.time_value, 0) - coalesce(i.invoiced_value, 0)) AS variance
FROM time_by_period t
FULL OUTER JOIN invoices_by_period i
  ON t.client_id = i.client_id AND t.period = i.period;`;

  return [
    { name: 'scope_usage_vw', sql: scopeUsage },
    { name: 'shelfware_vw', sql: shelfware },
    { name: 'underbilling_vw', sql: underbilling },
  ];
}

export async function main(): Promise<{ status: string }> {
  const statements = getQueries();
  for (const s of statements) {
    await startAndWait(s.sql);
    await previewOne(s.name);
  }
  return { status: 'ok' };
}

export const handler = main;

