// Central mock flags and helpers
import { USE_LOCAL_MOCK, MOCK_PATHS } from '../../../src/config/localConfig';
import { readJSON, writeJSON } from '../../../src/utils/localService';

const REPORTS_BUCKET = process.env.REPORTS_BUCKET || '';
const ACTIONS_TABLE = process.env.DDB_ACTIONS || '';
const CONTROLS_TABLE = process.env.DDB_CONTROLS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';

// No eager AWS clients; create on-demand in non-mock branches

async function streamToString(stream: any): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parseBody<T>(event: any): T | undefined {
  if (!event?.body) return undefined;
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    return undefined;
  }
}

async function loadDraft(actionId: string): Promise<any | undefined> {
  if (USE_LOCAL_MOCK) {
    try {
      return await readJSON(`${MOCK_PATHS.drafts}${actionId}.json`);
    } catch {
      return undefined;
    }
  }
  if (!REPORTS_BUCKET) return undefined;
  const key = `drafts/${actionId}.json`;
  try {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({});
    const obj = await s3.send(new GetObjectCommand({ Bucket: REPORTS_BUCKET, Key: key }));
    const text = await streamToString(obj.Body as any);
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function writePendingAction(event: any) {
  if (USE_LOCAL_MOCK) {
    const body = parseBody<any>(event) || {};
    const actionId = body.action_id;
    const draftS3Key = body.draft_s3_key || `drafts/${actionId}.json`;
    const coJson = body.co_json || {};
    if (!actionId) throw new Error('Missing required fields: action_id');
    const draft = await loadDraft(actionId);
    const breach = draft?.breach ?? {};
    const estSaving = coJson?.price_breakdown?.subtotal_inr ?? 0;
    const nowIso = new Date().toISOString();
    const ledger = (await readJSON(MOCK_PATHS.actions).catch(() => [])) as any[];
    const item = {
      action_id: actionId,
      client_id: breach.client_id,
      category: breach.category,
      status: 'PENDING',
      created_at: nowIso,
      est_saving_inr: estSaving,
      draft_key: draftS3Key,
      contract_id: breach.contract_id,
      period: breach.period,
    };
    const idx = ledger.findIndex((x) => x.action_id === actionId);
    if (idx >= 0) ledger[idx] = item; else ledger.push(item);
    await writeJSON(MOCK_PATHS.actions, ledger);
    return { status: 'PENDING', action_id: actionId };
  }
  const body = parseBody<any>(event) || {};
  const mode = body.mode;
  
  // Extract data from the event payload (from Step Functions)
  const actionId = body.action_id;
  const draftS3Key = body.draft_s3_key;
  const coJson = body.co_json || {};
  
  if (!actionId || !draftS3Key) {
    throw new Error('Missing required fields: action_id, draft_s3_key');
  }

  // Load draft to get breach information
  const draft = await loadDraft(actionId);
  const breach = draft?.breach ?? {};
  const estSaving = coJson?.price_breakdown?.subtotal_inr ?? 0;
  const nowIso = new Date().toISOString();

  // Write PENDING action to actions_ledger
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, PutCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await ddb.send(new PutCommand({
    TableName: ACTIONS_TABLE,
    Item: {
      action_id: actionId,
      client_id: breach.client_id,
      category: breach.category,
      status: 'PENDING',
      created_at: nowIso,
      est_saving_inr: estSaving,
      draft_key: draftS3Key,
      contract_id: breach.contract_id,
      period: breach.period,
    },
  }));

  // Set controls to paused for this client/category
  if (breach.client_id && breach.category) {
    const pk = `${breach.client_id}#${breach.category}`;
    await ddb.send(new UpdateCommand({
      TableName: CONTROLS_TABLE,
      Key: { pk },
      UpdateExpression: 'SET paused = :t, reason = :r, updated_at = :u',
      ExpressionAttributeValues: { 
        ':t': true, 
        ':r': 'Pending CO approval',
        ':u': nowIso 
      },
    }));
  }

  return { status: 'PENDING', action_id: actionId };
}

async function approveAction(event: any) {
  if (USE_LOCAL_MOCK) {
    const actionId = event?.pathParameters?.action_id || parseBody<any>(event)?.action_id;
    if (!actionId) return resp(400, { error: 'action_id required' });
    const body = parseBody<any>(event) || {};
    let draft = body.draft;
    if (!draft) draft = await loadDraft(actionId);
    const breach = draft?.breach ?? {};
    const co = draft?.co ?? draft ?? {};
    const estSaving = body.est_saving_inr ?? co?.price_breakdown?.subtotal_inr ?? 0;
    const nowIso = new Date().toISOString();
    const ledger = (await readJSON(MOCK_PATHS.actions).catch(() => [])) as any[];
    const item = {
      action_id: actionId,
      client_id: breach.client_id,
      category: breach.category,
      status: 'APPROVED',
      approved_at: nowIso,
      est_saving_inr: estSaving,
      draft_key: `drafts/${actionId}.json`,
      contract_id: breach.contract_id,
      period: breach.period,
    };
    const idx = ledger.findIndex((x) => x.action_id === actionId);
    if (idx >= 0) ledger[idx] = item; else ledger.push(item);
    await writeJSON(MOCK_PATHS.actions, ledger);
    const email = {
      subject: co?.customer_email_subject || `Approved change order for ${breach.category || ''}`,
      body: co?.customer_email_body || 'Change order approved.',
    };
    return resp(200, { status: 'APPROVED', action_id: actionId, email });
  }
  const actionId = event?.pathParameters?.action_id || parseBody<any>(event)?.action_id;
  if (!actionId) return resp(400, { error: 'action_id required' });

  const body = parseBody<any>(event) || {};
  let draft = body.draft;
  if (!draft) draft = await loadDraft(actionId);

  // Derive fields
  const breach = draft?.breach ?? {};
  const co = draft?.co ?? draft ?? {};
  const estSaving = body.est_saving_inr ?? co?.price_breakdown?.subtotal_inr ?? 0;
  const nowIso = new Date().toISOString();

  // Idempotent upsert into actions_ledger
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, PutCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await ddb.send(new PutCommand({
    TableName: ACTIONS_TABLE,
    Item: {
      action_id: actionId,
      client_id: breach.client_id,
      category: breach.category,
      status: 'APPROVED',
      approved_at: nowIso,
      est_saving_inr: estSaving,
      draft_key: `drafts/${actionId}.json`,
      contract_id: breach.contract_id,
      period: breach.period,
    },
  }));

  // Unpause controls for client/category
  if (breach.client_id && breach.category) {
    const pk = `${breach.client_id}#${breach.category}`;
    await ddb.send(new UpdateCommand({
      TableName: CONTROLS_TABLE,
      Key: { pk },
      UpdateExpression: 'SET paused = :f, reason = :r, updated_at = :t',
      ExpressionAttributeValues: { 
        ':f': false, 
        ':r': 'Approved and resumed',
        ':t': nowIso 
      },
    }));
  }

  // Prepare email (sandbox-safe: do not send if from/to not verified). Just return content.
  const email = {
    subject: co?.customer_email_subject || `Approved change order for ${breach.category || ''}`,
    body: co?.customer_email_body || 'Change order approved.',
  };
  if (EMAIL_FROM && body?.email_to && body?.send_email === true) {
    try {
      const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
      const ses = new SESClient({});
      await ses.send(new SendEmailCommand({
        Source: EMAIL_FROM,
        Destination: { ToAddresses: [body.email_to] },
        Message: {
          Subject: { Data: email.subject },
          Body: { Text: { Data: email.body } },
        },
      }));
    } catch {
      // ignore in sandbox
    }
  }

  return resp(200, { status: 'APPROVED', action_id: actionId, email });
}

async function listLedger(event: any) {
  if (USE_LOCAL_MOCK) {
    const clientId = event?.queryStringParameters?.client_id;
    // Remove unnecessary type argument, and add type declaration for items and filter parameter
    const items: any[] = await readJSON(MOCK_PATHS.actions).catch(() => []);
    const filtered = clientId ? items.filter((i: any) => i.client_id === clientId) : items;
    return resp(200, { items: filtered.slice(0, 50) });
  }
  const clientId = event?.queryStringParameters?.client_id;
  if (clientId) {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const out = await ddb.send(new QueryCommand({
      TableName: ACTIONS_TABLE,
      IndexName: 'gsi_client_id',
      KeyConditionExpression: 'client_id = :c',
      ExpressionAttributeValues: { ':c': clientId },
      Limit: 50,
      ScanIndexForward: false,
    }));
    return resp(200, { items: out.Items || [] });
  }
  {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const out = await ddb.send(new ScanCommand({ TableName: ACTIONS_TABLE, Limit: 50 }));
    return resp(200, { items: out.Items || [] });
  }
}

function resp(statusCode: number, body: any) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function main(event: any) {
  const method = event?.httpMethod;
  const path = event?.path || '';
  const body = parseBody<any>(event) || {};
  
  // Handle PENDING mode from Step Functions
  if (body.mode === 'PENDING') {
    return writePendingAction(event);
  }
  
  if (method === 'POST' && /\/actions\/.+\/approve$/.test(path)) {
    return approveAction(event);
  }
  if (method === 'GET' && path.endsWith('/ledger')) {
    return listLedger(event);
  }
  return resp(404, { error: 'Not found' });
}

export const handler = main;

