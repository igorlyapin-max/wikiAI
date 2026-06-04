import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('../redis.js', () => ({
  redis: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  },
}));

describe('Document processing config', () => {
  beforeEach(() => {
    store.clear();
  });

  it('returns defaults when unset', async () => {
    const { getDocumentProcessingConfig } = await import('../document-processing.js');
    const config = await getDocumentProcessingConfig();
    expect(config.attachmentsEnabled).toBe(true);
    expect(config.mimeTypes['application/pdf'].mode).toBe('text');
    expect(config.mimeTypes['image/png'].mode).toBe('ocr');
    expect(config.mimeTypes['application/vnd.openxmlformats-officedocument.wordprocessingml.document'].mode).toBe('text');
    expect(config.mimeTypes['application/zip'].mode).toBe('metadata');
  });

  it('saves and merges MIME policy with defaults', async () => {
    const { getDocumentProcessingConfig, setDocumentProcessingConfig } = await import('../document-processing.js');
    await setDocumentProcessingConfig({
      attachmentsEnabled: false,
      mimeTypes: {
        'image/png': { mode: 'metadata' },
        'application/x-custom': { mode: 'disabled' },
      },
    });

    const config = await getDocumentProcessingConfig();
    expect(config.attachmentsEnabled).toBe(false);
    expect(config.mimeTypes['application/pdf'].mode).toBe('text');
    expect(config.mimeTypes['image/png'].mode).toBe('metadata');
    expect(config.mimeTypes['application/x-custom'].mode).toBe('disabled');
  });

  it('rejects invalid modes', async () => {
    const { setDocumentProcessingConfig } = await import('../document-processing.js');
    await expect(setDocumentProcessingConfig({
      mimeTypes: { 'application/pdf': { mode: 'vision' } },
    })).rejects.toThrow();
  });
});
