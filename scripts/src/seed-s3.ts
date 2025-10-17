import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

function parseArgs(): { bucket?: string } {
  const idx = process.argv.indexOf('--bucket');
  return idx > -1 ? { bucket: process.argv[idx + 1] } : {};
}

const { bucket } = parseArgs();
const rawBucket = bucket || process.env.RAW_BUCKET || process.env.BUCKET;
if (!rawBucket) {
  console.error('Usage: pnpm ts-node scripts/seed-s3.ts --bucket <RAW_BUCKET>');
  process.exit(1);
}

const client = new S3Client({});
const samplesDir = path.resolve(process.cwd(), 'data-samples');

async function uploadFile(key: string, body: Buffer | string) {
  await client.send(new PutObjectCommand({ Bucket: rawBucket!, Key: key, Body: body }));
  console.log(`Uploaded -> s3://${rawBucket}/${key}`);
}

async function uploadCsvs() {
  const files = fs.existsSync(samplesDir) ? fs.readdirSync(samplesDir) : [];
  for (const file of files) {
    if (!file.endsWith('.csv')) continue;
    const full = path.join(samplesDir, file);
    if (!fs.statSync(full).isFile()) continue;
    const Body = fs.readFileSync(full);
    const Key = `raw/${file}`;
    await uploadFile(Key, Body);
  }
}

async function uploadPolicies() {
  const policy = {
    client_id: 'C001',
    contract_id: 'CT-1001',
    thresholds: [
      { category: 'how-to', limit: 10, rate_inr: 2000 },
    ],
  };
  const key = `policies/C001.json`;
  await uploadFile(key, Buffer.from(JSON.stringify(policy, null, 2)));
}

async function main() {
  await uploadCsvs();
  await uploadPolicies();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


