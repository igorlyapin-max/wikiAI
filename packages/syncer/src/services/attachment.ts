import { DocumentProcessingConfig, getMimeProcessingRule, MimeProcessingRule } from './document-policy.js';
import { logOperationalError } from './logging.js';
import { extractOfficeAttachmentText, isOfficeTextMimeType } from './office-extractor.js';

export interface AttachmentResult {
  text: string;
  metadata: Record<string, unknown>;
}

export function getMetadataText(filename: string, mimeType: string, metadata: Record<string, unknown>): string {
  const size = typeof metadata.size === 'number' ? `${metadata.size} bytes` : 'unknown size';
  const mode = typeof metadata.mode === 'string' ? metadata.mode : 'metadata';
  const format = typeof metadata.format === 'string' ? `, format: ${metadata.format}` : '';
  const error = typeof metadata.error === 'string' ? `, processing error: ${metadata.error}` : '';
  return `Attachment metadata: ${filename}; MIME: ${mimeType}; size: ${size}; processing mode: ${mode}${format}${error}`;
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
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker(rule.ocrLanguages ?? 'eng+rus');
      const {
        data: { text },
      } = await worker.recognize(buffer);
      await worker.terminate();
      return { text: text ?? '', metadata };
    } catch (err) {
      logOperationalError('attachment.ocr_error', err, { filename, mimeType });
      return { text: '', metadata: { ...metadata, error: 'ocr_failed' } };
    }
  }

  if (mimeType === 'text/plain' && rule.mode === 'text') {
    return { text: buffer.toString('utf-8'), metadata };
  }

  // Default: metadata only
  return { text: '', metadata };
}
