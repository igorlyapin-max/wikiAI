import Redis from 'ioredis';
import { z } from 'zod';
import { config } from '../config.js';

const DOCUMENT_PROCESSING_CONFIG_KEY = 'ai:document-processing:settings';

export const processingModeSchema = z.enum(['disabled', 'metadata', 'text', 'ocr']);
export type ProcessingMode = z.infer<typeof processingModeSchema>;

export interface MimeProcessingRule {
  mode: ProcessingMode;
  ocrLanguages?: string;
  maxBytes?: number;
}

export interface DocumentProcessingConfig {
  attachmentsEnabled: boolean;
  mimeTypes: Record<string, MimeProcessingRule>;
}

const mimeRuleSchema = z.object({
  mode: processingModeSchema,
  ocrLanguages: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().optional(),
}).strict();

const documentProcessingPatchSchema = z.object({
  attachmentsEnabled: z.boolean().optional(),
  mimeTypes: z.record(mimeRuleSchema).optional(),
}).strict();

export const DEFAULT_DOCUMENT_PROCESSING_CONFIG: DocumentProcessingConfig = {
  attachmentsEnabled: true,
  mimeTypes: {
    'application/pdf': { mode: 'text' },
    'text/plain': { mode: 'text' },
    'image/png': { mode: 'ocr', ocrLanguages: 'eng+rus' },
    'image/jpeg': { mode: 'ocr', ocrLanguages: 'eng+rus' },
    'image/jpg': { mode: 'ocr', ocrLanguages: 'eng+rus' },
    'image/webp': { mode: 'ocr', ocrLanguages: 'eng+rus' },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { mode: 'text' },
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { mode: 'text' },
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': { mode: 'text' },
    'application/vnd.oasis.opendocument.text': { mode: 'text' },
    'application/vnd.oasis.opendocument.spreadsheet': { mode: 'text' },
    'application/vnd.oasis.opendocument.presentation': { mode: 'text' },
    'audio/mpeg': { mode: 'metadata' },
    'audio/mp3': { mode: 'metadata' },
    'audio/wav': { mode: 'metadata' },
    'audio/x-wav': { mode: 'metadata' },
    'video/mpeg': { mode: 'metadata' },
    'application/zip': { mode: 'metadata' },
    'application/x-zip-compressed': { mode: 'metadata' },
    'application/x-7z-compressed': { mode: 'metadata' },
  },
};

export function normalizeDocumentProcessingConfig(input: unknown): DocumentProcessingConfig {
  const parsed = documentProcessingPatchSchema.parse(input);
  return {
    attachmentsEnabled: parsed.attachmentsEnabled ?? DEFAULT_DOCUMENT_PROCESSING_CONFIG.attachmentsEnabled,
    mimeTypes: {
      ...DEFAULT_DOCUMENT_PROCESSING_CONFIG.mimeTypes,
      ...(parsed.mimeTypes ?? {}),
    },
  };
}

export function getMimeProcessingRule(mimeType: string, policy: DocumentProcessingConfig): MimeProcessingRule {
  return policy.mimeTypes[mimeType] ?? { mode: 'metadata' };
}

export async function getDocumentProcessingConfig(): Promise<DocumentProcessingConfig> {
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await redis.connect();
    const raw = await redis.get(DOCUMENT_PROCESSING_CONFIG_KEY);
    if (!raw) return normalizeDocumentProcessingConfig({});
    return normalizeDocumentProcessingConfig(JSON.parse(raw) as unknown);
  } catch (err) {
    console.warn('Document policy unavailable, using defaults:', (err as Error).message);
    return normalizeDocumentProcessingConfig({});
  } finally {
    redis.disconnect();
  }
}
