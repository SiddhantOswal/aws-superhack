import { USE_LOCAL_MOCK, MOCK_PATHS } from '../../../src/config/localConfig';
import { readJSON, queryAthenaMock, invokeLambdaMock, safeAwsImport } from '../../../src/utils/localService';

const RAW_BUCKET = process.env.RAW_BUCKET || '';
const ATHENA_DB = process.env.ATHENA_DB || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || '';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN || '';

interface PolicyThreshold {
  category: string;
  limit: number;
  rate_inr?: number;
}

interface PolicyFile {
  client_id: string;
  contract_id?: string;
  thresholds: PolicyThreshold[];
}

async function streamToString(stream: any): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function startAndWait(query: string): Promise<{ client: any; id: string }> {
  const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, QueryExecutionState } = await safeAwsImport('@aws-sdk/client-athena');
  const region = process.env.AWS_REGION || 'ap-south-1';
  const client = new AthenaClient({ region });
  const start = await client.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      QueryExecutionContext: { Database: ATHENA_DB },
      WorkGroup: ATHENA_WORKGROUP,
    }),
  );
  const id = start.QueryExecutionId!;
  const startTime = Date.now();
  const timeoutMs = 3 * 60 * 1000;
  while (true) {
    const exec = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State as string | undefined;
    if (state === 'SUCCEEDED') return { client, id };
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Athena query ${id} ${state}: ${exec.QueryExecution?.Status?.StateChangeReason}`);
    }
    if (Date.now() - startTime > timeoutMs) throw new Error(`Athena query ${id} timed out`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function getHoursFor(clientId: string, category: string, isoMonth: string): Promise<number> {
  const q = `SELECT coalesce(sum(total_billable_hours),0) AS hours_month
FROM scope_usage_vw
WHERE client_id='${clientId.replace(/'/g, "''")}'
  AND category='${category.replace(/'/g, "''")}'
  AND date_trunc('month', month) = date_trunc('month', date('${isoMonth}'))`;
  try {
    const { GetQueryResultsCommand } = await safeAwsImport('@aws-sdk/client-athena');
    const { client, id } = await startAndWait(q);
    const res = await client.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 5 }));
    const row = res.ResultSet?.Rows?.[1]?.Data?.[0]?.VarCharValue;
    const val = row ? parseFloat(row) : 0;
    return Number.isFinite(val) ? val : 0;
  } catch {
    return 0;
  }
}

export async function main(): Promise<{ breaches_started: number }> {
  if (USE_LOCAL_MOCK) {
    // Local mode: read policies from mock-data and simulate Athena via local time entries aggregation
    // eslint-disable-next-line no-console
    console.log('Using local mock for policy evaluator');
    const policies = await readJSON<any[]>(MOCK_PATHS.policies).catch(() => []);
    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    let started = 0;
    for (const p of policies) {
      const clientId = p.client_id || p.client || '';
      const thresholds = p.thresholds || [];
      for (const th of thresholds) {
        // Treat category as project in time_entries
        const rows = await queryAthenaMock(MOCK_PATHS.time_entries, {
          where: { client: clientId, project: th.category },
          sumBy: 'hours',
          groupBy: ['client', 'project'],
        });
        const hours = Number(rows?.[0]?.sum_hours || 0);
        if (hours > (th.limit ?? 0)) {
          const breachEvent = {
            client_id: clientId,
            contract_id: p.contract_id,
            category: th.category,
            limit: th.limit,
            actual: hours,
            rate_inr: th.rate_inr ?? 0,
            period,
            policy_key: 'mock-data/policies.json',
          };
          try {
            await invokeLambdaMock('draft-change-order', breachEvent);
            started += 1;
          } catch {
            // ignore in local mode
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Breaches started (local): ${started}`);
    return { breaches_started: started };
  }
  if (!RAW_BUCKET || !ATHENA_DB || !ATHENA_WORKGROUP) {
    throw new Error('Missing env RAW_BUCKET/ATHENA_DB/ATHENA_WORKGROUP');
  }
  if (!STATE_MACHINE_ARN) {
    // eslint-disable-next-line no-console
    console.warn('STATE_MACHINE_ARN not set; breaches will not trigger executions');
  }

  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await safeAwsImport('@aws-sdk/client-s3');
  const region = process.env.AWS_REGION || 'ap-south-1';
  const s3 = new S3Client({ region });
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: RAW_BUCKET, Prefix: 'policies/' }));
  const keys = (listed.Contents || [])
    .map((o: any) => o.Key!)
    .filter((k: any) => (k as string).endsWith('.json'));

  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  let started = 0;

  for (const key of keys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: key }));
    const text = await streamToString(obj.Body as any);
    let policy: PolicyFile;
    try {
      policy = JSON.parse(text);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`Invalid JSON in policy: s3://${RAW_BUCKET}/${key}`);
      continue;
    }

    for (const th of (policy.thresholds || []) as any[]) {
      const hours = await getHoursFor(policy.client_id, th.category, period);
      if (hours > (th.limit ?? 0)) {
        const breachEvent = {
          client_id: policy.client_id,
          contract_id: policy.contract_id,
          category: th.category,
          limit: th.limit,
          actual: hours,
          rate_inr: th.rate_inr ?? 0,
          period,
          policy_key: key,
        };
        if (STATE_MACHINE_ARN) {
          const { SFNClient, StartExecutionCommand } = await safeAwsImport('@aws-sdk/client-sfn');
          const region = process.env.AWS_REGION || 'ap-south-1';
          const sfn = new SFNClient({ region });
          await sfn.send(new StartExecutionCommand({
            stateMachineArn: STATE_MACHINE_ARN,
            input: JSON.stringify(breachEvent),
          }));
          started += 1;
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Breaches started: ${started}`);
  return { breaches_started: started };
}

export const handler = main;

