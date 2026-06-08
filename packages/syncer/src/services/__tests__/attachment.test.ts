import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import { buildAttachmentSearchableChunks, getMetadataText, processAttachment } from '../attachment.js';
import { normalizeDocumentProcessingConfig } from '../document-policy.js';

const pdfGetText = vi.hoisted(() => vi.fn());
const pdfDestroy = vi.hoisted(() => vi.fn());
const recognize = vi.hoisted(() => vi.fn());
const terminate = vi.hoisted(() => vi.fn());
interface MockTesseractWorkerOptions {
  errorHandler?: (err: unknown) => void;
  langPath?: string;
  cachePath?: string;
}

const createWorker = vi.hoisted(() => vi.fn(async (
  _languages?: string | string[],
  _oem?: number,
  _options?: MockTesseractWorkerOptions
) => ({
  recognize,
  terminate,
})));

vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn(function PDFParse() {
    return {
      getText: pdfGetText,
      destroy: pdfDestroy,
    };
  }),
}));

vi.mock('tesseract.js', () => ({ createWorker }));

const tempDirs: string[] = [];

function createStoredZip(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

describe('attachment processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.tesseractLangPath = undefined;
    config.tesseractCachePath = undefined;
    config.tesseractOcrLanguages = undefined;
    config.tesseractAllowNetworkLangDownload = true;
    pdfGetText.mockResolvedValue({ text: 'PDF text', total: 3 });
    pdfDestroy.mockResolvedValue(undefined);
    recognize.mockResolvedValue({ data: { text: 'OCR text' } });
    terminate.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
    expect(getMetadataText('note.txt', 'text/plain', result.metadata, 'Sandbox Page')).toContain('parent page: Sandbox Page');
  });

  it('adds filename, MIME and parent page to every searchable attachment chunk', () => {
    const chunks = buildAttachmentSearchableChunks({
      filename: 'Wikiai-architecture.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pageTitle: 'CorpCommon:Приказы/Режим рабочего времени',
      chunks: ['Архитектурный WikiAI', 'RAG ColBERT Qdrant ACL'],
    });

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk).toContain('Файл: Wikiai-architecture.pptx');
      expect(chunk).toContain('MIME: application/vnd.openxmlformats-officedocument.presentationml.presentation');
      expect(chunk).toContain('Родительская страница: CorpCommon:Приказы/Режим рабочего времени');
    }
    expect(chunks[1]).toContain('RAG ColBERT Qdrant ACL');
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
      requestedOcrLanguages: ['eng'],
      ocrLanguageSource: 'network',
    });
    expect(createWorker).toHaveBeenCalledWith(
      ['eng'],
      1,
      expect.objectContaining({ errorHandler: expect.any(Function) })
    );
    expect(terminate).toHaveBeenCalled();
  });

  it('returns safe metadata and terminates the OCR worker when recognition fails', async () => {
    recognize.mockRejectedValueOnce(new Error('bad image'));
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'image/png': { mode: 'ocr', ocrLanguages: 'eng' } },
    });

    const result = await processAttachment(Buffer.from('png'), 'image/png', 'broken.png', policy);

    expect(result.text).toBe('');
    expect(result.metadata).toMatchObject({
      filename: 'broken.png',
      mode: 'ocr',
      error: 'ocr_failed',
    });
    expect(terminate).toHaveBeenCalled();
  });

  it('handles OCR worker errorHandler failures without running recognition', async () => {
    createWorker.mockImplementationOnce(async (_languages, _oem, options) => {
      options?.errorHandler?.(new Error('worker failed'));
      return { recognize, terminate };
    });
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'image/png': { mode: 'ocr', ocrLanguages: 'eng' } },
    });

    const result = await processAttachment(Buffer.from('png'), 'image/png', 'screen.png', policy);

    expect(result.text).toBe('');
    expect(result.metadata.error).toBe('ocr_failed');
    expect(recognize).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
  });

  it('uses the available local OCR language subset without falling back to CDN', async () => {
    const tessdataDir = await mkdtemp(join(tmpdir(), 'wikiai-tessdata-'));
    tempDirs.push(tessdataDir);
    await writeFile(join(tessdataDir, 'rus.traineddata'), '');
    config.tesseractAllowNetworkLangDownload = false;
    config.tesseractLangPath = tessdataDir;
    config.tesseractCachePath = join(tessdataDir, 'cache');
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'image/png': { mode: 'ocr', ocrLanguages: 'eng+rus' } },
    });

    const result = await processAttachment(Buffer.from('png'), 'image/png', 'screen.png', policy);

    expect(result.text).toBe('OCR text');
    expect(result.metadata).toMatchObject({
      requestedOcrLanguages: ['eng', 'rus'],
      ocrLanguages: ['rus'],
      missingOcrLanguages: ['eng'],
      ocrLanguageSource: 'local',
      ocrLangPath: tessdataDir,
      ocrCachePath: join(tessdataDir, 'cache'),
    });
    expect(createWorker).toHaveBeenCalledWith(
      ['rus'],
      1,
      expect.objectContaining({
        langPath: tessdataDir,
        cachePath: join(tessdataDir, 'cache'),
        errorHandler: expect.any(Function),
      })
    );
  });

  it('returns metadata-only when local OCR language data is not configured', async () => {
    config.tesseractAllowNetworkLangDownload = false;
    config.tesseractLangPath = undefined;
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'image/png': { mode: 'ocr', ocrLanguages: 'eng+rus' } },
    });

    const result = await processAttachment(Buffer.from('png'), 'image/png', 'screen.png', policy);

    expect(result.text).toBe('');
    expect(result.metadata).toMatchObject({
      filename: 'screen.png',
      mode: 'ocr',
      requestedOcrLanguages: ['eng', 'rus'],
      ocrLanguageSource: 'not_configured',
      error: 'ocr_language_path_not_configured',
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('returns metadata-only when requested local OCR language data is missing', async () => {
    const tessdataDir = await mkdtemp(join(tmpdir(), 'wikiai-tessdata-'));
    tempDirs.push(tessdataDir);
    config.tesseractAllowNetworkLangDownload = false;
    config.tesseractLangPath = tessdataDir;
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'image/png': { mode: 'ocr', ocrLanguages: 'eng+rus' } },
    });

    const result = await processAttachment(Buffer.from('png'), 'image/png', 'screen.png', policy);

    expect(result.text).toBe('');
    expect(result.metadata).toMatchObject({
      filename: 'screen.png',
      mode: 'ocr',
      requestedOcrLanguages: ['eng', 'rus'],
      ocrLanguages: [],
      missingOcrLanguages: ['eng', 'rus'],
      ocrLanguageSource: 'local',
      error: 'ocr_language_data_missing',
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('extracts DOCX text from office XML packages', async () => {
    const policy = normalizeDocumentProcessingConfig({});
    const buffer = createStoredZip([
      {
        name: 'word/document.xml',
        content: '<w:document><w:body><w:p><w:r><w:t>Human control</w:t></w:r></w:p><w:p><w:t>RAG protocol</w:t></w:p></w:body></w:document>',
      },
    ]);

    const result = await processAttachment(
      buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'brief.docx',
      policy
    );

    expect(result.text).toContain('Human control');
    expect(result.text).toContain('RAG protocol');
    expect(result.metadata).toMatchObject({
      filename: 'brief.docx',
      mode: 'text',
      format: 'docx',
      zipEntries: 1,
    });
  });

  it('extracts ODT text from content.xml', async () => {
    const policy = normalizeDocumentProcessingConfig({});
    const buffer = createStoredZip([
      {
        name: 'content.xml',
        content: '<office:document-content><office:body><text:p>Русский текст ODT</text:p></office:body></office:document-content>',
      },
    ]);

    const result = await processAttachment(
      buffer,
      'application/vnd.oasis.opendocument.text',
      'manual.odt',
      policy
    );

    expect(result.text).toContain('Русский текст ODT');
    expect(result.metadata.format).toBe('odt');
  });

  it('keeps archives metadata-only and searchable by processing mode', async () => {
    const policy = normalizeDocumentProcessingConfig({});
    const result = await processAttachment(Buffer.from('PK'), 'application/zip', 'archive.zip', policy);

    expect(result.text).toBe('');
    expect(result.metadata.mode).toBe('metadata');
    expect(getMetadataText('archive.zip', 'application/zip', result.metadata)).toContain('processing mode: metadata');
  });
});
