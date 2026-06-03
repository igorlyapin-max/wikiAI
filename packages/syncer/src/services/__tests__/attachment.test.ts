import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMetadataText, processAttachment } from '../attachment.js';
import { normalizeDocumentProcessingConfig } from '../document-policy.js';

const pdfGetText = vi.hoisted(() => vi.fn());
const pdfDestroy = vi.hoisted(() => vi.fn());
const recognize = vi.hoisted(() => vi.fn());
const terminate = vi.hoisted(() => vi.fn());

vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn(function PDFParse() {
    return {
      getText: pdfGetText,
      destroy: pdfDestroy,
    };
  }),
}));

vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => ({
    recognize,
    terminate,
  })),
}));

describe('attachment processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pdfGetText.mockResolvedValue({ text: 'PDF text', total: 3 });
    pdfDestroy.mockResolvedValue(undefined);
    recognize.mockResolvedValue({ data: { text: 'OCR text' } });
    terminate.mockResolvedValue(undefined);
  });

  it('extracts text/plain when policy mode is text', async () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'text/plain': { mode: 'text' } },
    });
    const result = await processAttachment(Buffer.from('hello wiki'), 'text/plain', 'note.txt', policy);
    expect(result.text).toBe('hello wiki');
    expect(result.metadata.mode).toBe('text');
  });

  it('returns metadata-only for metadata mode', async () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'text/plain': { mode: 'metadata' } },
    });
    const result = await processAttachment(Buffer.from('hidden'), 'text/plain', 'note.txt', policy);
    expect(result.text).toBe('');
    expect(result.metadata.mode).toBe('metadata');
    expect(getMetadataText('note.txt', 'text/plain', result.metadata)).toContain('note.txt');
  });

  it('returns metadata error when maxBytes is exceeded', async () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'text/plain': { mode: 'text', maxBytes: 2 } },
    });
    const result = await processAttachment(Buffer.from('hidden'), 'text/plain', 'note.txt', policy);
    expect(result.text).toBe('');
    expect(result.metadata.error).toBe('max_bytes_exceeded');
  });

  it('extracts PDF text and records page count', async () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'application/pdf': { mode: 'text' } },
    });

    const result = await processAttachment(Buffer.from('%PDF'), 'application/pdf', 'policy.pdf', policy);

    expect(result.text).toBe('PDF text');
    expect(result.metadata).toMatchObject({
      filename: 'policy.pdf',
      mimeType: 'application/pdf',
      mode: 'text',
      pages: 3,
    });
    expect(pdfDestroy).toHaveBeenCalled();
  });

  it('returns safe metadata when PDF parsing fails', async () => {
    pdfGetText.mockRejectedValueOnce(new Error('bad pdf'));
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'application/pdf': { mode: 'text' } },
    });

    const result = await processAttachment(Buffer.from('%PDF'), 'application/pdf', 'bad.pdf', policy);

    expect(result.text).toBe('');
    expect(result.metadata).toMatchObject({
      mode: 'text',
      error: 'pdf_parse_failed',
    });
    expect(pdfDestroy).toHaveBeenCalled();
  });

  it('runs OCR for image attachments when policy mode is ocr', async () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'image/png': { mode: 'ocr', ocrLanguages: 'eng' } },
    });

    const result = await processAttachment(Buffer.from('png'), 'image/png', 'screen.png', policy);

    expect(result.text).toBe('OCR text');
    expect(result.metadata).toMatchObject({
      filename: 'screen.png',
      mode: 'ocr',
    });
    expect(terminate).toHaveBeenCalled();
  });
});
