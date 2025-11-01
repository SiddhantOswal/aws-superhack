// Avoid static AWS imports; will dynamically import in non-mock branch
import { USE_LOCAL_MOCK, MOCK_PATHS } from "../../../src/config/localConfig";
import { readJSON } from "../../../src/utils/localService";

const ATHENA_DB = process.env.ATHENA_DB || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || '';

async function startAndWait(query: string): Promise<{ client: any; id: string }> {
  const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand } = await import('@aws-sdk/client-athena');
  const region = process.env.AWS_REGION || 'ap-south-1';
  const athena = new AthenaClient({ region });
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
    // Compute reclaimable seats and annual savings using local JSON mocks
    const licenses = await readJSON<any[]>(MOCK_PATHS.licenses).catch(() => []);
    const logins = await readJSON<any[]>(MOCK_PATHS.logins).catch(() => []);

    // active user count by client|app
    const activeByKey = new Map<string, number>();
    for (const l of logins as any[]) {
      if (l?.active) {
        const key = `${l.client}|${l.product}`;
        activeByKey.set(key, (activeByKey.get(key) || 0) + 1);
      }
    }

    const items = (licenses as any[])
      .map((lic: any) => {
        const key = `${lic.client}|${lic.product}`;
        const active = activeByKey.get(key) || 0;
        const reclaimable = Math.max(0, Number(lic.seats || 0) - active);
        const annual_saving_inr = reclaimable * Number(lic.rate_inr || 0) * 12;
        return {
          client_id: lic.client,
          app: lic.product,
          reclaimable_seats: reclaimable,
          annual_saving_inr,
        };
      })
      .sort((a: any, b: any) => b.annual_saving_inr - a.annual_saving_inr)
      .slice(0, 20);

    return { items };
  }

  if (!ATHENA_DB || !ATHENA_WORKGROUP) throw new Error('Missing ATHENA_DB/ATHENA_WORKGROUP');
  const query = `SELECT client_id, app, reclaimable_seats, annual_saving AS annual_saving_inr
FROM shelfware_vw
ORDER BY annual_saving DESC
LIMIT 20`;
  const { GetQueryResultsCommand } = await import('@aws-sdk/client-athena');
  const { client, id } = await startAndWait(query);
  const res = await client.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 1000 }));
  const items = rowsToItems(res.ResultSet?.Rows || []);
  return { items };
}

export const handler = main;

