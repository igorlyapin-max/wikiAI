import { describe, expect, it } from 'vitest';
import { rememberOnce } from '../redis.js';
import {
  getWebhookTitle,
  normalizeEvent,
  signWebhookPayload,
  verifyWebhookSignature,
  WebhookBody,
} from '../webhook.js';

describe('webhook contract', () => {
  it('keeps canonical event names', () => {
    expect(normalizeEvent('edit')).toBe('edit');
    expect(normalizeEvent('delete')).toBe('delete');
    expect(normalizeEvent('move')).toBe('move');
    expect(normalizeEvent('protect')).toBe('protect');
  });

  it('accepts legacy MediaWiki event aliases', () => {
    expect(normalizeEvent('page_save')).toBe('edit');
    expect(normalizeEvent('page_delete')).toBe('delete');
    expect(normalizeEvent('page_move')).toBe('move');
    expect(normalizeEvent('page_protect')).toBe('protect');
  });

  it('uses title before new_title', () => {
    expect(getWebhookTitle({ title: 'A', new_title: 'B' })).toBe('A');
    expect(getWebhookTitle({ new_title: 'B' })).toBe('B');
    expect(getWebhookTitle({})).toBeNull();
  });

  it('accepts a valid HMAC signature', () => {
    const body: WebhookBody = {
      event: 'edit',
      page_id: 42,
      title: 'Runbook',
      namespace: 0,
      rev_id: 7,
      timestamp: '2026-06-06T12:00:00Z',
    };
    const timestamp = '1780747200';
    const signature = signWebhookPayload('secret', timestamp, body);

    expect(verifyWebhookSignature({
      headers: {
        'x-wikiai-webhook-timestamp': timestamp,
        'x-wikiai-webhook-signature': signature,
        'x-wikiai-webhook-idempotency-key': 'edit:42:7',
      },
      body,
      secret: 'secret',
      toleranceSeconds: 300,
      nowSeconds: 1780747200,
    })).toEqual({ ok: true, replayKey: 'edit:42:7' });
  });

  it('rejects unsigned webhook payloads', () => {
    const body: WebhookBody = {
      event: 'delete',
      page_id: 42,
      title: 'Runbook',
      namespace: 0,
      timestamp: '2026-06-06T12:00:00Z',
    };

    expect(verifyWebhookSignature({
      headers: {},
      body,
      secret: 'secret',
      toleranceSeconds: 300,
      nowSeconds: 1780747200,
    })).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects expired webhook timestamps', () => {
    const body: WebhookBody = {
      event: 'protect',
      page_id: 42,
      title: 'Runbook',
      namespace: 0,
      timestamp: '2026-06-06T12:00:00Z',
    };
    const timestamp = '1780747200';

    expect(verifyWebhookSignature({
      headers: {
        'x-wikiai-webhook-timestamp': timestamp,
        'x-wikiai-webhook-signature': signWebhookPayload('secret', timestamp, body),
      },
      body,
      secret: 'secret',
      toleranceSeconds: 300,
      nowSeconds: 1780747601,
    })).toEqual({ ok: false, reason: 'expired_timestamp' });
  });

  it('rejects replayed idempotency keys', async () => {
    const replayKey = `syncer:webhook:test:${Date.now()}`;

    await expect(rememberOnce(replayKey, 60)).resolves.toBe(true);
    await expect(rememberOnce(replayKey, 60)).resolves.toBe(false);
  });
});
