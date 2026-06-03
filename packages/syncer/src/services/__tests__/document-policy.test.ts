import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDocumentProcessingConfig,
  getMimeProcessingRule,
  normalizeDocumentProcessingConfig,
} from '../document-policy.js';

const redisMock = vi.hoisted(() => ({
  connect: vi.fn(),
  get: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: vi.fn(function RedisMock() {
    return redisMock;
  }),
}));

describe('document policy', () => {
  beforeEach(() => {
    redisMock.connect.mockReset();
    redisMock.get.mockReset();
    redisMock.disconnect.mockReset();
  });

  it('merges overrides with defaults', () => {
    const policy = normalizeDocumentProcessingConfig({
      attachmentsEnabled: false,
      mimeTypes: {
        'image/png': { mode: 'metadata' },
        'application/x-custom': { mode: 'disabled' },
      },
    });

    expect(policy.attachmentsEnabled).toBe(false);
    expect(policy.mimeTypes['application/pdf'].mode).toBe('text');
    expect(policy.mimeTypes['image/png'].mode).toBe('metadata');
    expect(policy.mimeTypes['application/x-custom'].mode).toBe('disabled');
  });

  it('preserves OCR languages and max byte overrides', () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: {
        'image/png': { mode: 'ocr', ocrLanguages: 'eng+rus+deu', maxBytes: 10_000 },
      },
    });

    expect(policy.mimeTypes['image/png']).toEqual({
      mode: 'ocr',
      ocrLanguages: 'eng+rus+deu',
      maxBytes: 10_000,
    });
  });

  it('defaults unknown MIME types to metadata mode', () => {
    const policy = normalizeDocumentProcessingConfig({});
    expect(getMimeProcessingRule('application/x-unknown', policy).mode).toBe('metadata');
  });

  it('rejects invalid policy modes', () => {
    expect(() => normalizeDocumentProcessingConfig({
      mimeTypes: { 'application/pdf': { mode: 'vision' } },
    })).toThrow();
  });

  it('loads persisted Redis policy and disconnects after reading', async () => {
    redisMock.connect.mockResolvedValueOnce(undefined);
    redisMock.get.mockResolvedValueOnce(JSON.stringify({
      attachmentsEnabled: false,
      mimeTypes: {
        'application/pdf': { mode: 'metadata', maxBytes: 2048 },
      },
    }));

    await expect(getDocumentProcessingConfig()).resolves.toMatchObject({
      attachmentsEnabled: false,
      mimeTypes: {
        'application/pdf': { mode: 'metadata', maxBytes: 2048 },
      },
    });
    expect(redisMock.connect).toHaveBeenCalledTimes(1);
    expect(redisMock.get).toHaveBeenCalledWith('ai:document-processing:settings');
    expect(redisMock.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to defaults when Redis policy is missing or unavailable', async () => {
    redisMock.connect.mockResolvedValueOnce(undefined);
    redisMock.get.mockResolvedValueOnce(null);

    await expect(getDocumentProcessingConfig()).resolves.toMatchObject({
      attachmentsEnabled: true,
      mimeTypes: {
        'application/pdf': { mode: 'text' },
      },
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    redisMock.connect.mockRejectedValueOnce(new Error('redis offline'));

    await expect(getDocumentProcessingConfig()).resolves.toMatchObject({
      attachmentsEnabled: true,
    });
    expect(warn).toHaveBeenCalledWith(
      'Document policy unavailable, using defaults:',
      'redis offline'
    );
    expect(redisMock.disconnect).toHaveBeenCalledTimes(2);
  });
});
