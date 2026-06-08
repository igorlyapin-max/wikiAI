import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const hooksPath = path.resolve(process.cwd(), '../../src/Hooks.php');
const hooksSource = fs.readFileSync(hooksPath, 'utf8');

describe('Hooks webhook contract', () => {
  it('passes JSON webhook headers as MediaWiki associative headers', () => {
    expect(hooksSource).toContain("'Content-Type' => 'application/json'");
    expect(hooksSource).toContain("'X-WikiAI-Webhook-Timestamp'] = $signatureTimestamp");
    expect(hooksSource).toContain("'X-WikiAI-Webhook-Signature'] = self::signWebhookPayload");
    expect(hooksSource).toContain('$httpRequest->setHeader($name, $value);');
    expect(hooksSource).toContain('private const WEBHOOK_JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;');
    expect(hooksSource).toContain('json_encode($payload, self::WEBHOOK_JSON_FLAGS)');
    expect(hooksSource).toContain('json_encode(self::canonicalizeWebhookValue($payload), self::WEBHOOK_JSON_FLAGS)');
    expect(hooksSource).not.toContain("'headers' => $headers");
    expect(hooksSource).not.toContain("'Content-Type: application/json'");
    expect(hooksSource).not.toContain("$headers[] = 'X-WikiAI-Webhook-Timestamp");
  });
});
