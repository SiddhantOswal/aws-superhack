// Avoid static AWS imports; will dynamically import in non-mock branch
import { USE_LOCAL_MOCK, MOCK_PATHS } from '../../../src/config/localConfig';
import { readJSON, safeAwsImport } from '../../../src/utils/localService';

const ATHENA_DB = process.env.ATHENA_DB || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || '';

async function startAndWait(query: string): Promise<{ client: any; id: string }> {
  const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand } = await safeAwsImport('@aws-sdk/client-athena');
  const athena = new AthenaClient({});
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
    const st = exec.QueryExecution?.Status?.State as string | undefined;
    if (st === 'SUCCEEDED') return { client: athena, id };
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
  if (USE_LOCAL_MOCK) {
    const timeEntries = await readJSON<any[]>(MOCK_PATHS.time_entries).catch(() => []);
    const invoices = await readJSON<any[]>(MOCK_PATHS.invoices).catch(() => []);
    // Sum hours per client-month
    const hoursMap = new Map<string, number>(); // key: client|YYYY-MM
    for (const t of timeEntries as any[]) {
      const ym = String(t.date).slice(0, 7);
      const key = `${t.client}|${ym}`;
      const hours = Number(t.hours || 0);
      hoursMap.set(key, (hoursMap.get(key) || 0) + hours);
    }
    // Sum billed per client-month
    const billedMap = new Map<string, number>();
    for (const inv of invoices as any[]) {
      const ym = String(inv.period_start).slice(0, 7);
      const key = `${inv.client}|${ym}`;
      const total = Number(inv.total_inr || 0);
      billedMap.set(key, (billedMap.get(key) || 0) + total);
    }
    const items: any[] = [];
    for (const [key, hours] of hoursMap.entries() as any) {
      const [client_id, period] = key.split('|');
      const assumed_rate_inr = 2200;
      const expected_inr = Math.round(hours * assumed_rate_inr);
      const billed_inr = Math.round(billedMap.get(key) || 0);
      const delta_inr = expected_inr - billed_inr;
      if (delta_inr > 0) {
        items.push({ client_id, period, hours, assumed_rate_inr, expected_inr, billed_inr, delta_inr, suggestion: `Addendum: Invoice delta INR ${delta_inr} for ${period}` });
      }
    }
    items.sort((a, b) => b.delta_inr - a.delta_inr);
    return { items: items.slice(0, 50) };
  }
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
  const { GetQueryResultsCommand } = await safeAwsImport('@aws-sdk/client-athena');
  const { client, id } = await startAndWait(query);
  const res = await client.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 1000 }));
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

