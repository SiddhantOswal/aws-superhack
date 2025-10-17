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
  // rows[0] is header
  const header = rows[0]?.Data?.map((d: any) => d?.VarCharValue) || [];
  const out: any[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]?.Data || [];
    const obj: any = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = r[c]?.VarCharValue;
    }
    out.push(obj);
  }
  return out;
}

export async function main(): Promise<{ items: any[] }> {
  if (!ATHENA_DB || !ATHENA_WORKGROUP) throw new Error('Missing ATHENA_DB/ATHENA_WORKGROUP');
  const query = `SELECT client_id, app, reclaimable_seats, annual_saving AS annual_saving_inr
FROM shelfware_vw
ORDER BY annual_saving DESC
LIMIT 20`;
  const id = await startAndWait(query);
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 1000 }));
  const items = rowsToItems(res.ResultSet?.Rows || []);
  return { items };
}

export const handler = main;

