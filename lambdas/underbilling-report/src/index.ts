import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';

const ATHENA_DB = process.env.ATHENA_DB || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || '';

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
  const t0 = Date.now();
  const timeoutMs = 120000;
  while (true) {
    const exec = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const st = exec.QueryExecution?.Status?.State as QueryExecutionState | undefined;
    if (st === 'SUCCEEDED') return id;
    if (st === 'FAILED' || st === 'CANCELLED') throw new Error(`Athena ${id} ${st}`);
    if (Date.now() - t0 > timeoutMs) throw new Error('Athena timeout');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function rowsToItems(rows: any[]): any[] {
  const header = rows[0]?.Data?.map((d: any) => d?.VarCharValue) || [];
  const out: any[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]?.Data || [];
    const obj: any = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = r[c]?.VarCharValue;
    out.push(obj);
  }
  return out;
}

export async function main(): Promise<{ items: any[] }> {
  if (!ATHENA_DB || !ATHENA_WORKGROUP) throw new Error('Missing ATHENA_DB/ATHENA_WORKGROUP');
  const query = `
WITH hourly AS (
  SELECT client_id, period, sum(coalesce(total_billable_hours,0)) AS hours
  FROM scope_usage_vw
  GROUP BY client_id, period
), billed AS (
  SELECT client_id, period, sum(coalesce(amount,0)) AS billed_inr
  FROM invoices
  GROUP BY client_id, period
)
SELECT
  coalesce(h.client_id, b.client_id) AS client_id,
  coalesce(h.period, b.period) AS period,
  coalesce(h.hours, 0) AS hours,
  2200 AS assumed_rate_inr,
  cast(coalesce(h.hours,0) * 2200 as bigint) AS expected_inr,
  coalesce(b.billed_inr, 0) AS billed_inr,
  cast((coalesce(h.hours,0) * 2200) - coalesce(b.billed_inr,0) as bigint) AS delta_inr
FROM hourly h
FULL OUTER JOIN billed b ON h.client_id = b.client_id AND h.period = b.period
HAVING ((coalesce(h.hours,0) * 2200) - coalesce(b.billed_inr,0)) > 0
ORDER BY delta_inr DESC
LIMIT 50`;
  const id = await startAndWait(query);
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 1000 }));
  const rows = res.ResultSet?.Rows || [];
  const items = rowsToItems(rows).map((r) => ({
    client_id: r.client_id,
    period: r.period,
    hours: Number(r.hours || 0),
    assumed_rate_inr: Number(r.assumed_rate_inr || 2200),
    expected_inr: Number(r.expected_inr || 0),
    billed_inr: Number(r.billed_inr || 0),
    delta_inr: Number(r.delta_inr || 0),
    suggestion: `Addendum: Invoice delta INR ${r.delta_inr} for ${r.period}`,
  }));
  return { items };
}

export const handler = main;

