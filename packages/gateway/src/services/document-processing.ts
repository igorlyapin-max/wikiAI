import { z } from 'zod';
import { redis } from './redis.js';

const DOCUMENT_PROCESSING_CONFIG_KEY = 'ai:document-processing:settings';

export const documentProcessingModeSchema = z.enum(['disabled', 'metadata', 'text', 'ocr']);

export type DocumentProcessingMode = z.infer<typeof documentProcessingModeSchema>;

export interface MimeProcessingRule {
  mode: DocumentProcessingMode;
  ocrLanguages?: string;
  maxBytes?: number;
}

export interface DocumentProcessingConfig {
  attachmentsEnabled: boolean;
  mimeTypes: Record<string, MimeProcessingRule>;
}

const mimeRuleSchema = z.object({
  mode: documentProcessingModeSchema,
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
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { mode: 'metadata' },
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

export async function getDocumentProcessingConfig(): Promise<DocumentProcessingConfig> {
  const raw = await redis.get(DOCUMENT_PROCESSING_CONFIG_KEY);
  if (!raw) return { ...DEFAULT_DOCUMENT_PROCESSING_CONFIG, mimeTypes: { ...DEFAULT_DOCUMENT_PROCESSING_CONFIG.mimeTypes } };

  try {
    return normalizeDocumentProcessingConfig(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_DOCUMENT_PROCESSING_CONFIG, mimeTypes: { ...DEFAULT_DOCUMENT_PROCESSING_CONFIG.mimeTypes } };
  }
}

export async function setDocumentProcessingConfig(input: unknown): Promise<DocumentProcessingConfig> {
  const updated = normalizeDocumentProcessingConfig(input);
  await redis.set(DOCUMENT_PROCESSING_CONFIG_KEY, JSON.stringify(updated));
  return updated;
}

export async function resetDocumentProcessingConfig(): Promise<DocumentProcessingConfig> {
  await redis.set(DOCUMENT_PROCESSING_CONFIG_KEY, JSON.stringify(DEFAULT_DOCUMENT_PROCESSING_CONFIG));
  return { ...DEFAULT_DOCUMENT_PROCESSING_CONFIG, mimeTypes: { ...DEFAULT_DOCUMENT_PROCESSING_CONFIG.mimeTypes } };
}
