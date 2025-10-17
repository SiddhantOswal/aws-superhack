import PDFDocument from 'pdfkit';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REPORTS_BUCKET = process.env.REPORTS_BUCKET || '';
const ACTIONS_TABLE = process.env.DDB_ACTIONS || '';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type QbrInput = {
  client_id: string;
  period: string; // YYYY-MM
};

async function fetchApprovedActions(clientId: string, period: string) {
  const monthPrefix = `${period}-`;
  const out = await ddb.send(
    new QueryCommand({
      TableName: ACTIONS_TABLE,
      IndexName: 'gsi_client_id',
      KeyConditionExpression: 'client_id = :c',
      ExpressionAttributeValues: { ':c': clientId },
      Limit: 200,
      ScanIndexForward: false,
    }),
  );
  const items = (out.Items || []).filter((i: any) => i.status === 'APPROVED' && (i.period?.startsWith(monthPrefix) || i.period?.startsWith(period)));
  return items.slice(0, 10);
}

function renderBars(doc: PDFDocument, x: number, y: number, beforePct: number, afterPct: number) {
  const width = 300;
  const height = 12;
  // Before bar (outline)
  doc.rect(x, y, width, height).stroke();
  doc.rect(x, y, Math.max(0, Math.min(width, (beforePct / 100) * width)), height).fillAndStroke('#cccccc', '#000000');
  // After bar (overlay below)
  const y2 = y + 24;
  doc.rect(x, y2, width, height).stroke();
  doc.rect(x, y2, Math.max(0, Math.min(width, (afterPct / 100) * width)), height).fillAndStroke('#88c999', '#000000');
  doc.fillColor('black');
  doc.text(`GM% Before: ${beforePct.toFixed(1)}%`, x + width + 10, y - 2);
  doc.text(`GM% After: ${afterPct.toFixed(1)}%`, x + width + 10, y2 - 2);
}

async function generatePdf(clientId: string, period: string, actions: any[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: any[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Header
    doc.fontSize(18).text('Quarterly Business Review', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Client: ${clientId}`);
    doc.text(`Period: ${period}`);
    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.8);

    // KPI
    const estSaving = actions.reduce((sum, a) => sum + (Number(a.est_saving_inr) || 0), 0);
    doc.fontSize(14).text("This month's KPIs");
    doc.fontSize(12).text(`Estimated Savings (INR): ${estSaving.toLocaleString('en-IN')}`);
    doc.text(`Actions Approved: ${actions.length}`);
    doc.moveDown(1);

    // GM bars (mock before/after)
    const beforePct = 32.0;
    const afterPct = Math.min(95, beforePct + Math.min(10 + actions.length * 1.5, 20));
    renderBars(doc, 60, doc.y, beforePct, afterPct);
    doc.moveDown(2);

    // Actions section
    doc.fontSize(14).text("This month's actions");
    doc.fontSize(11);
    for (const a of actions) {
      const line = `- ${a.category ?? 'scope'} | saving: INR ${Number(a.est_saving_inr || 0).toLocaleString('en-IN')} | approved_at: ${a.approved_at ?? ''}`;
      doc.text(line);
    }

    doc.end();
  });
}

export async function main(event: any): Promise<{ signedUrl: string }> {
  if (!REPORTS_BUCKET || !ACTIONS_TABLE) throw new Error('Missing REPORTS_BUCKET/DDB_ACTIONS');
  const body = typeof event?.body === 'string' ? JSON.parse(event.body) : event?.body || {};
  const clientId: string = body.client_id || event?.queryStringParameters?.client_id;
  const period: string = body.period || event?.queryStringParameters?.period; // YYYY-MM
  if (!clientId || !period) {
    throw new Error('client_id and period required');
  }

  const actions = await fetchApprovedActions(clientId, period);
  const pdf = await generatePdf(clientId, period, actions);

  const key = `pdf/${clientId}-${period}.pdf`;
  await s3.send(new PutObjectCommand({ Bucket: REPORTS_BUCKET, Key: key, Body: pdf, ContentType: 'application/pdf' }));

  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: REPORTS_BUCKET, Key: key }), { expiresIn: 15 * 60 });
  return { signedUrl: url };
}

export const handler = main;

