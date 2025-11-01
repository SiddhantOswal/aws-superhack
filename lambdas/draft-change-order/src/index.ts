import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { USE_LOCAL_MOCK, MOCK_PATHS } from '../../src/config/localConfig';
import { writeJSON } from '../../src/utils/localService';
import * as path from 'path';
import { randomUUID } from 'crypto';

const REPORTS_BUCKET = process.env.REPORTS_BUCKET || '';

const s3 = new S3Client({});

type BreachEvent = {
  client_id: string;
  contract_id?: string;
  category: string;
  limit: number;
  actual: number;
  rate_inr?: number;
  period: string; // YYYY-MM-01
  policy_key?: string;
};

// Bedrock helper functions
type SchemaName = 'changeOrder';

const SCHEMAS = {
  changeOrder: {
    systemPrompt: 'You are a contract operations writer. Output valid JSON only with keys: title, scope_delta, reason, price_breakdown{hours_over,rate,subtotal_inr}, customer_email_subject, customer_email_body.',
    maxTokens: 600,
    temperature: 0,
  },
} as const;

type BedrockContext = {
  [key: string]: any;
};

type FallbackFactory<T> = (context: BedrockContext) => T;

async function callBedrockOrFallback<T>(
  schemaName: SchemaName,
  context: BedrockContext,
  fallbackFactory: FallbackFactory<T>
): Promise<T> {
  const schema = SCHEMAS[schemaName];
  const region = process.env.BEDROCK_REGION || 'us-east-1';
  const modelId = 'amazon.nova-micro-v1:0';

  // Try Bedrock first
  try {
    // Dynamic import to keep optional dependency truly optional
    const mod = await (Function('return import("@aws-sdk/client-bedrock-runtime")')() as Promise<any>);
    const { BedrockRuntimeClient, InvokeModelCommand } = mod;
    const client = new BedrockRuntimeClient({ region });
    
    // Build concise prompt from context
    const contextStr = Object.entries(context)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    
    const body = JSON.stringify({
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: schema.systemPrompt }]
        },
        {
          role: 'user',
          content: [{ type: 'text', text: `Context: ${contextStr}.` }]
        }
      ],
      temperature: schema.temperature,
      maxTokens: schema.maxTokens,
    });

    const response = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body,
      })
    );

    const responseText = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(responseText);
    
    // Extract text from various response formats
    const text = parsed?.outputText ?? 
                 parsed?.content?.[0]?.text ?? 
                 parsed?.results?.[0]?.outputText;

    if (!text) {
      throw new Error('No text content in Bedrock response');
    }

    // Try to extract JSON from the response
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonStr = text.slice(jsonStart, jsonEnd + 1);
      const result = JSON.parse(jsonStr);
      console.log(`Bedrock success for schema ${schemaName}`);
      return result;
    } else {
      // If no JSON found, try parsing the entire text
      const result = JSON.parse(text);
      console.log(`Bedrock success for schema ${schemaName} (full text)`);
      return result;
    }

  } catch (error) {
    console.warn(`Bedrock failed for schema ${schemaName}:`, error instanceof Error ? error.message : String(error));
    
    // Fall back to deterministic template
    const fallback = fallbackFactory(context);
    console.log(`Using fallback for schema ${schemaName}`);
    return fallback;
  }
}

function fallbackDraft(event: BreachEvent) {
  const hoursOver = Math.max(0, event.actual - (event.limit ?? 0));
  const rate = event.rate_inr ?? 0;
  const subtotal = Math.round(hoursOver * rate);
  return {
    title: `Change Order: Additional ${hoursOver}h for ${event.category}`,
    scope_delta: `Increase scope due to overage in ${event.category} for period ${event.period}.`,
    reason: `Usage exceeded contracted limit of ${event.limit}h; actual was ${event.actual}h.`,
    price_breakdown: {
      hours_over: hoursOver,
      rate,
      subtotal_inr: subtotal,
    },
    customer_email_subject: `Action required: Approve change order (${event.category})`,
    customer_email_body: `Dear customer,\n\nWe detected ${hoursOver}h over the contracted ${event.limit}h in ${event.category} for ${event.period}. Please approve the attached change order.\n\nRegards,\nMSP Growth OS`,
  };
}

export async function main(event: BreachEvent): Promise<{ action_id: string; draft_s3_key: string; co_json: any }> {
  if (USE_LOCAL_MOCK) {
    const actionId = randomUUID();
    const key = `drafts/${actionId}.json`;
    const coJson = fallbackDraft(event);
    await writeJSON(path.join(MOCK_PATHS.drafts, `${actionId}.json`), { breach: event, co: coJson });
    return { action_id: actionId, draft_s3_key: key, co_json: coJson };
  }
  if (!REPORTS_BUCKET) throw new Error('Missing REPORTS_BUCKET');
  const actionId = randomUUID();

  // Use shared Bedrock helper with fallback
  const coJson = await callBedrockOrFallback(
    'changeOrder' as SchemaName,
    {
      client_id: event.client_id,
      contract_id: event.contract_id || '',
      category: event.category,
      limit: event.limit,
      actual: event.actual,
      rate_inr: event.rate_inr || 0,
      period: event.period,
    },
    fallbackDraft
  );

  const key = `drafts/${actionId}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: REPORTS_BUCKET,
    Key: key,
    Body: Buffer.from(JSON.stringify({ breach: event, co: coJson }, null, 2)),
    ContentType: 'application/json',
  }));

  return { action_id: actionId, draft_s3_key: key, co_json: coJson };
}

export const handler = main;

