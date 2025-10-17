import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const RAW_BUCKET = process.env.RAW_BUCKET || '';
const ATHENA_DB = process.env.ATHENA_DB || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || '';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN || '';

const s3 = new S3Client({});
const athena = new AthenaClient({});
const sfn = new SFNClient({});

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

async function startAndWait(query: string): Promise<string> {
  const start = await athena.send(
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
    const exec = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State as QueryExecutionState | undefined;
    if (state === 'SUCCEEDED') return id;
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
  const id = await startAndWait(q);
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 5 }));
  // Row 0 is header, row 1 is first data
  const row = res.ResultSet?.Rows?.[1]?.Data?.[0]?.VarCharValue;
  const val = row ? parseFloat(row) : 0;
  return Number.isFinite(val) ? val : 0;
}

export async function main(): Promise<{ breaches_started: number }> {
  if (!RAW_BUCKET || !ATHENA_DB || !ATHENA_WORKGROUP) {
    throw new Error('Missing env RAW_BUCKET/ATHENA_DB/ATHENA_WORKGROUP');
  }
  if (!STATE_MACHINE_ARN) {
    // eslint-disable-next-line no-console
    console.warn('STATE_MACHINE_ARN not set; breaches will not trigger executions');
  }

  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: RAW_BUCKET, Prefix: 'policies/' }),
  );
  const keys = (listed.Contents || [])
    .map((o) => o.Key!)
    .filter((k) => k.endsWith('.json'));

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

    for (const th of policy.thresholds || []) {
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
          await sfn.send(
            new StartExecutionCommand({
              stateMachineArn: STATE_MACHINE_ARN,
              input: JSON.stringify(breachEvent),
            }),
          );
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

