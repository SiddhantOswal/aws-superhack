import { USE_LOCAL_MOCK, MOCK_PATHS } from '../../../src/config/localConfig';
import { readJSON, putS3Mock, safeAwsImport } from '../../../src/utils/localService';
import * as path from 'path';

const REPORTS_BUCKET = process.env.REPORTS_BUCKET || '';
const ACTIONS_TABLE = process.env.DDB_ACTIONS || '';

type QbrInput = {
  client_id: string;
  period: string; // YYYY-MM
};

async function fetchApprovedActions(clientId: string, period: string) {
  if (USE_LOCAL_MOCK) {
    const monthPrefix = `${period}-`;
    const items = (await readJSON<any[]>(MOCK_PATHS.actions).catch(() => []))
      .filter((i: any) => i.client_id === clientId && i.status === 'APPROVED' && (i.period?.startsWith(monthPrefix) || i.period?.startsWith(period)));
    return items.slice(0, 10);
  }
  const monthPrefix = `${period}-`;
  const { DynamoDBClient } = await safeAwsImport('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, QueryCommand } = await safeAwsImport('@aws-sdk/lib-dynamodb');
  const region = process.env.AWS_REGION || 'ap-south-1';
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const out = await ddb.send(new QueryCommand({
    TableName: ACTIONS_TABLE,
    IndexName: 'gsi_client_id',
    KeyConditionExpression: 'client_id = :c',
    ExpressionAttributeValues: { ':c': clientId },
    Limit: 200,
    ScanIndexForward: false,
  }));
  const items = (out.Items || []).filter((i: any) => i.status === 'APPROVED' && ((i.period as any)?.startsWith(monthPrefix) || (i.period as any)?.startsWith(period)));
  return items.slice(0, 10);
}

function generateHtml(clientId: string, period: string, actions: any[]): string {
  const estSaving = actions.reduce((sum, a) => sum + (Number(a.est_saving_inr) || 0), 0);
  const items = actions.map((a) => `
      <li>${a.category ?? 'scope'} | saving: INR ${Number(a.est_saving_inr || 0).toLocaleString('en-IN')} | approved_at: ${a.approved_at ?? ''}</li>
    `).join('');
  return `<!doctype html>
  <html>
    <head>
      <meta charset=\"utf-8\" />
      <title>QBR - ${clientId} - ${period}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 24px; }
        h1 { margin-bottom: 8px; }
        h2 { margin-top: 24px; }
      </style>
    </head>
    <body>
      <h1>Quarterly Business Review</h1>
      <div>Client: <b>${clientId}</b></div>
      <div>Period: <b>${period}</b></div>
      <hr />
      <h2>This month's KPIs</h2>
      <div>Estimated Savings (INR): <b>${estSaving.toLocaleString('en-IN')}</b></div>
      <div>Actions Approved: <b>${actions.length}</b></div>
      <h2>This month's actions</h2>
      <ul>${items}</ul>
    </body>
  </html>`;
}

export async function main(event: any): Promise<{ signedUrl: string }> {
  const body = typeof event?.body === 'string' ? JSON.parse(event.body) : event?.body || {};
  const clientId: string = body.client_id || event?.queryStringParameters?.client_id;
  const period: string = body.period || event?.queryStringParameters?.period; // YYYY-MM
  if (!clientId || !period) {
    throw new Error('client_id and period required');
  }

  const actions = await fetchApprovedActions(clientId, period);

  if (USE_LOCAL_MOCK) {
    const html = generateHtml(clientId, period, actions);
    const filename = `${clientId}-${period}.html`;
    await putS3Mock('qbr', filename, html);
    const filePath = path.join(MOCK_PATHS.qbr, filename);
    return { signedUrl: `file://${filePath}` } as any;
  }

  if (!REPORTS_BUCKET || !ACTIONS_TABLE) throw new Error('Missing REPORTS_BUCKET/DDB_ACTIONS');
  const { S3Client, PutObjectCommand, GetObjectCommand } = await safeAwsImport('@aws-sdk/client-s3');
  const { getSignedUrl } = await safeAwsImport('@aws-sdk/s3-request-presigner');
  const region = process.env.AWS_REGION || 'ap-south-1';
  const s3 = new S3Client({ region });
  const { default: PDFDocument } = await import('pdfkit');

  // Build PDF dynamically in non-mock mode
  const pdf: Buffer = await new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: any[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).text('Quarterly Business Review', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Client: ${clientId}`);
    doc.text(`Period: ${period}`);
    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.8);

    const estSaving = actions.reduce((sum, a) => sum + (Number(a.est_saving_inr) || 0), 0);
    doc.fontSize(14).text("This month's KPIs");
    doc.fontSize(12).text(`Estimated Savings (INR): ${estSaving.toLocaleString('en-IN')}`);
    doc.text(`Actions Approved: ${actions.length}`);
    doc.moveDown(1);

    doc.fontSize(14).text("This month's actions");
    doc.fontSize(11);
    for (const a of actions) {
      const line = `- ${a.category ?? 'scope'} | saving: INR ${Number(a.est_saving_inr || 0).toLocaleString('en-IN')} | approved_at: ${a.approved_at ?? ''}`;
      doc.text(line);
    }
    doc.end();
  });

  const key = `pdf/${clientId}-${period}.pdf`;
  await s3.send(new PutObjectCommand({ Bucket: REPORTS_BUCKET, Key: key, Body: pdf, ContentType: 'application/pdf' }));
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: REPORTS_BUCKET, Key: key }), { expiresIn: 15 * 60 });
  return { signedUrl: url };
}

export const handler = main;

