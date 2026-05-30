import { config } from '../config.js';

export interface AttachmentResult {
  text: string;
  metadata: Record<string, unknown>;
}

// MIME type → processor config
const mimeConfig: Record<string, { extract: boolean; ocr: boolean }> = {
  'application/pdf': { extract: true, ocr: false },
  'image/png': { extract: false, ocr: true },
  'image/jpeg': { extract: false, ocr: true },
  'image/jpg': { extract: false, ocr: true },
  'image/webp': { extract: false, ocr: true },
  'text/plain': { extract: true, ocr: false },
};

export function getMimeConfig(mimeType: string): { extract: boolean; ocr: boolean } {
  return mimeConfig[mimeType] ?? { extract: false, ocr: false };
}

export async function processAttachment(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<AttachmentResult> {
  const cfg = getMimeConfig(mimeType);
  const metadata: Record<string, unknown> = {
    filename,
    mimeType,
    size: buffer.length,
  };

  if (mimeType === 'application/pdf' && cfg.extract) {
    try {
      const pdfParseMod = await import("pdf-parse");
      const data = await (pdfParseMod as any).default?.(buffer) ?? await (pdfParseMod as any)(buffer);
      return { text: data.text ?? '', metadata: { ...metadata, pages: data.numpages } };
    } catch (err) {
      console.error('PDF parse error:', (err as Error).message);
      return { text: '', metadata: { ...metadata, error: 'pdf_parse_failed' } };
    }
  }

  if (cfg.ocr && mimeType.startsWith('image/')) {
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng+rus');
      const {
        data: { text },
      } = await worker.recognize(buffer);
      await worker.terminate();
      return { text: text ?? '', metadata };
    } catch (err) {
      console.error('OCR error:', (err as Error).message);
      return { text: '', metadata: { ...metadata, error: 'ocr_failed' } };
    }
  }

  if (mimeType === 'text/plain' && cfg.extract) {
    return { text: buffer.toString('utf-8'), metadata };
  }

  // Default: metadata only
  return { text: '', metadata: { ...metadata, mode: 'metadata_only' } };
}
