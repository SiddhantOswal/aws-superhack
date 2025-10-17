import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const handler = async (event: any) => {
  const requestType = event.RequestType;
  if (requestType === 'Delete') return { PhysicalResourceId: 'prefix-writer' };
  const props = event.ResourceProperties as any;
  const s3 = new S3Client({});
  const put = async (bucket: string, key: string) => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${key}.keep`, Body: 'keep' }));
  };
  for (const p of props.rawPrefixes || []) {
    await put(props.rawBucket, p);
  }
  for (const p of props.reportPrefixes || []) {
    await put(props.reportsBucket, p);
  }
  return { PhysicalResourceId: 'prefix-writer' };
};


