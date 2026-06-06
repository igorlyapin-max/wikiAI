import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { timingSafeEqualString } from './security.js';

export type CanonicalWebhookEvent = 'edit' | 'delete' | 'move' | 'protect';

export interface WebhookBody {
  event: CanonicalWebhookEvent | 'page_save' | 'page_delete' | 'page_move' | 'page_protect';
  page_id: number;
  title?: string;
  old_title?: string;
  new_title?: string;
  namespace: number;
  rev_id?: number;
  timestamp: string;
  user?: string;
  user_id?: number;
  summary?: string;
}

const webhookEventSchema = z.union([
  z.literal('edit'),
  z.literal('delete'),
  z.literal('move'),
  z.literal('protect'),
  z.literal('page_save'),
  z.literal('page_delete'),
  z.literal('page_move'),
  z.literal('page_protect'),
]);

export const webhookBodySchema = z.object({
  event: webhookEventSchema,
  page_id: z.number().int().positive(),
  title: z.string().min(1).optional(),
  old_title: z.string().min(1).optional(),
  new_title: z.string().min(1).optional(),
  namespace: z.number().int().min(0),
  rev_id: z.preprocess((value) => value === null ? undefined : value, z.number().int().positive().optional()),
  timestamp: z.string().min(1),
  user: z.string().optional(),
  user_id: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
}).strict();

export interface WebhookSignatureVerification {
  ok: boolean;
  reason?: 'missing_signature' | 'missing_timestamp' | 'expired_timestamp' | 'invalid_timestamp' | 'invalid_signature';
  replayKey?: string;
}

export function normalizeEvent(event: WebhookBody['event']): CanonicalWebhookEvent | null {
  if (event === 'page_save') return 'edit';
  if (event === 'page_delete') return 'delete';
  if (event === 'page_move') return 'move';
  if (event === 'page_protect') return 'protect';
  if (event === 'edit' || event === 'delete' || event === 'move' || event === 'protect') return event;
  return null;
}

export function getWebhookTitle(body: Pick<WebhookBody, 'title' | 'new_title'>): string | null {
  return body.title ?? body.new_title ?? null;
}

function readHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return readHeader({ [name]: value[0] }, name);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entryValue]) => [entryKey, canonicalize(entryValue)])
    );
  }
  return value;
}

export function canonicalWebhookJson(body: WebhookBody): string {
  return JSON.stringify(canonicalize(body));
}

export function signWebhookPayload(secret: string, timestamp: string, body: WebhookBody): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${canonicalWebhookJson(body)}`)
    .digest('hex');
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(input: {
  headers: Record<string, unknown>;
  body: WebhookBody;
  secret: string;
  toleranceSeconds: number;
  nowSeconds?: number;
}): WebhookSignatureVerification {
  const signature = readHeader(input.headers, 'x-wikiai-webhook-signature');
  if (!signature) return { ok: false, reason: 'missing_signature' };

  const timestamp = readHeader(input.headers, 'x-wikiai-webhook-timestamp');
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: 'invalid_timestamp' };

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > input.toleranceSeconds) {
    return { ok: false, reason: 'expired_timestamp' };
  }

  const expected = signWebhookPayload(input.secret, timestamp, input.body);
  if (!timingSafeEqualString(signature, expected)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return {
    ok: true,
    replayKey: readHeader(input.headers, 'x-wikiai-webhook-idempotency-key') ?? signature,
  };
}

export function parseWebhookBody(body: unknown): WebhookBody {
  return webhookBodySchema.parse(body);
}
