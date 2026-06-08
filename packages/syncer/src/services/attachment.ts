import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { DocumentProcessingConfig, getMimeProcessingRule, MimeProcessingRule } from './document-policy.js';
import { config } from '../config.js';
import { logOperationalError } from './logging.js';
import { extractOfficeAttachmentText, isOfficeTextMimeType } from './office-extractor.js';

export interface AttachmentResult {
  text: string;
  metadata: Record<string, unknown>;
}

export interface AttachmentSearchableChunkInput {
  filename: string;
  mimeType: string;
  pageTitle?: string;
  text: string;
}

function attachmentContextLines(input: Pick<AttachmentSearchableChunkInput, 'filename' | 'mimeType' | 'pageTitle'>): string[] {
  return [
    `Файл: ${input.filename}`,
    `MIME: ${input.mimeType}`,
    ...(input.pageTitle && input.pageTitle.trim().length > 0 ? [`Родительская страница: ${input.pageTitle.trim()}`] : []),
  ];
}

export function buildAttachmentSearchableChunkText(input: AttachmentSearchableChunkInput): string {
  return [
    ...attachmentContextLines(input),
    input.text.trim(),
  ].filter((line) => line.length > 0).join('\n');
}

export function buildAttachmentSearchableChunks(input: {
  filename: string;
  mimeType: string;
  pageTitle?: string;
  chunks: string[];
}): string[] {
  return input.chunks
    .map((text) => buildAttachmentSearchableChunkText({
      filename: input.filename,
      mimeType: input.mimeType,
      pageTitle: input.pageTitle,
      text,
    }))
    .filter((text) => text.trim().length > 0);
}

export function getMetadataText(filename: string, mimeType: string, metadata: Record<string, unknown>, pageTitle?: string): string {
  const size = typeof metadata.size === 'number' ? `${metadata.size} bytes` : 'unknown size';
  const mode = typeof metadata.mode === 'string' ? metadata.mode : 'metadata';
  const format = typeof metadata.format === 'string' ? `, format: ${metadata.format}` : '';
  const error = typeof metadata.error === 'string' ? `, processing error: ${metadata.error}` : '';
  const page = pageTitle && pageTitle.trim().length > 0 ? `; parent page: ${pageTitle.trim()}` : '';
  return `Attachment metadata: ${filename}; MIME: ${mimeType}${page}; size: ${size}; processing mode: ${mode}${format}${error}`;
}

function splitOcrLanguages(value: string | undefined): string[] {
  const languages = (value ?? 'eng+rus')
    .split(/[+,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return languages.length > 0 ? Array.from(new Set(languages)) : ['eng', 'rus'];
}

async function hasLocalTrainedData(langPath: string, language: string): Promise<boolean> {
  for (const suffix of ['.traineddata', '.traineddata.gz']) {
    try {
      await access(join(langPath, `${language}${suffix}`));
      return true;
    } catch {
      // Try the next supported local traineddata extension.
    }
  }
  return false;
}

async function resolveOcrLanguagePlan(rule: MimeProcessingRule): Promise<{
  languages: string[];
  metadata: Record<string, unknown>;
  error?: 'ocr_language_data_missing' | 'ocr_language_path_not_configured';
}> {
  const requestedLanguages = splitOcrLanguages(config.tesseractOcrLanguages ?? rule.ocrLanguages);

  if (!config.tesseractLangPath) {
    if (config.tesseractAllowNetworkLangDownload) {
      return {
        languages: requestedLanguages,
        metadata: {
          requestedOcrLanguages: requestedLanguages,
          ocrLanguageSource: 'network',
        },
      };
    }
    return {
      languages: [],
      error: 'ocr_language_path_not_configured',
      metadata: {
        requestedOcrLanguages: requestedLanguages,
        ocrLanguageSource: 'not_configured',
      },
    };
  }

  const availableLanguages: string[] = [];
  const missingLanguages: string[] = [];
  for (const language of requestedLanguages) {
    if (await hasLocalTrainedData(config.tesseractLangPath, language)) {
      availableLanguages.push(language);
    } else {
      missingLanguages.push(language);
    }
  }

  const metadata: Record<string, unknown> = {
    requestedOcrLanguages: requestedLanguages,
    ocrLanguages: availableLanguages,
    ocrLanguageSource: 'local',
    ocrLangPath: config.tesseractLangPath,
  };
  if (config.tesseractCachePath) metadata.ocrCachePath = config.tesseractCachePath;
  if (missingLanguages.length > 0) metadata.missingOcrLanguages = missingLanguages;
  if (availableLanguages.length === 0) {
    return {
      languages: [],
      error: 'ocr_language_data_missing',
      metadata,
    };
  }

  return {
    languages: availableLanguages,
    metadata,
  };
}

function normalizeWorkerError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  return new Error('Tesseract worker error');
}

export async function processAttachment(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  policy: DocumentProcessingConfig
): Promise<AttachmentResult> {
  const rule = getMimeProcessingRule(mimeType, policy);
  const metadata: Record<string, unknown> = {
    filename,
    mimeType,
    size: buffer.length,
    mode: rule.mode,
  };

  if (rule.maxBytes !== undefined && buffer.length > rule.maxBytes) {
    return { text: '', metadata: { ...metadata, error: 'max_bytes_exceeded' } };
  }

  if (rule.mode === 'text' && isOfficeTextMimeType(mimeType)) {
    try {
      const result = extractOfficeAttachmentText(buffer, mimeType);
      return {
        text: result.text,
        metadata: { ...metadata, ...result.metadata },
      };
    } catch (err) {
      logOperationalError('attachment.office_extract_error', err, { filename, mimeType });
      return { text: '', metadata: { ...metadata, error: 'office_extract_failed' } };
    }
  }

  if (mimeType === 'application/pdf' && rule.mode === 'text') {
    let parser: { getText: () => Promise<{ text?: string; total?: number }>; destroy: () => Promise<void> } | null = null;
    try {
      const { PDFParse } = await import('pdf-parse');
      parser = new PDFParse({ data: buffer });
      const data = await parser.getText();
      return { text: data.text ?? '', metadata: { ...metadata, pages: data.total } };
    } catch (err) {
      logOperationalError('attachment.pdf_parse_error', err, { filename, mimeType });
      return { text: '', metadata: { ...metadata, error: 'pdf_parse_failed' } };
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }

  if (rule.mode === 'ocr' && mimeType.startsWith('image/')) {
    let worker: { recognize: (image: Buffer) => Promise<{ data: { text?: string } }>; terminate: () => Promise<unknown> } | null = null;
    let workerError: unknown;
    try {
      const languagePlan = await resolveOcrLanguagePlan(rule);
      if (languagePlan.error) {
        logOperationalError('attachment.ocr_language_data_unavailable', new Error(languagePlan.error), {
          filename,
          mimeType,
          ...languagePlan.metadata,
        });
        return {
          text: '',
          metadata: {
            ...metadata,
            ...languagePlan.metadata,
            error: languagePlan.error,
          },
        };
      }

      const { createWorker } = await import('tesseract.js');
      const workerOptions: Parameters<typeof createWorker>[2] = {
        errorHandler: (err: unknown) => {
          workerError = err;
          logOperationalError('attachment.ocr_worker_error', err, { filename, mimeType });
        },
      };
      if (config.tesseractLangPath) workerOptions.langPath = config.tesseractLangPath;
      if (config.tesseractCachePath) workerOptions.cachePath = config.tesseractCachePath;
      worker = await createWorker(languagePlan.languages, 1, workerOptions);
      if (workerError) throw normalizeWorkerError(workerError);
      const {
        data: { text },
      } = await worker.recognize(buffer);
      if (workerError) throw normalizeWorkerError(workerError);
      return {
        text: text ?? '',
        metadata: {
          ...metadata,
          ...languagePlan.metadata,
        },
      };
    } catch (err) {
      logOperationalError('attachment.ocr_error', err, { filename, mimeType });
      return { text: '', metadata: { ...metadata, error: 'ocr_failed' } };
    } finally {
      await worker?.terminate().catch((err: unknown) => {
        logOperationalError('attachment.ocr_terminate_error', err, { filename, mimeType });
      });
    }
  }

  if (mimeType === 'text/plain' && rule.mode === 'text') {
    return { text: buffer.toString('utf-8'), metadata };
  }

  // Default: metadata only
  return { text: '', metadata };
}
