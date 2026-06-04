import { inflateRawSync } from 'node:zlib';

export interface OfficeExtractionResult {
  text: string;
  metadata: Record<string, unknown>;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ZipEntryContent extends ZipEntry {
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

export const OFFICE_TEXT_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

export function isOfficeTextMimeType(mimeType: string): boolean {
  return OFFICE_TEXT_MIME_TYPES.has(mimeType);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('zip_eocd_not_found');
}

function readCentralDirectoryEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('zip_central_directory_invalid');
    }

    const generalPurposeFlag = buffer.readUInt16LE(offset + 8);
    if ((generalPurposeFlag & 0x1) !== 0) {
      throw new Error('zip_encrypted_entries_not_supported');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + filenameLength)
      .toString('utf8');

    if (!name.endsWith('/')) {
      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    offset += 46 + filenameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntryContent(buffer: Buffer, entry: ZipEntry): ZipEntryContent {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('zip_local_header_invalid');
  }

  const filenameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + filenameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  const data = entry.method === 0
    ? Buffer.from(compressed)
    : entry.method === 8
      ? inflateRawSync(compressed)
      : Buffer.alloc(0);

  if (data.length === 0 && entry.uncompressedSize > 0) {
    throw new Error(`zip_method_${entry.method}_not_supported`);
  }

  return { ...entry, data };
}

function readZip(buffer: Buffer): ZipEntryContent[] {
  return readCentralDirectoryEntries(buffer).map((entry) => readZipEntryContent(buffer, entry));
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function xmlToText(xml: string): string {
  return decodeXmlEntities(xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function normalizeText(parts: string[]): string {
  return parts
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textFromEntries(entries: ZipEntryContent[], predicate: (name: string) => boolean): string {
  return normalizeText(
    entries
      .filter((entry) => predicate(entry.name))
      .map((entry) => xmlToText(entry.data.toString('utf8')))
  );
}

function officeFormat(mimeType: string): string {
  switch (mimeType) {
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx';
    case 'application/vnd.oasis.opendocument.text':
      return 'odt';
    case 'application/vnd.oasis.opendocument.spreadsheet':
      return 'ods';
    case 'application/vnd.oasis.opendocument.presentation':
      return 'odp';
    default:
      return 'office';
  }
}

function extractTextForMime(entries: ZipEntryContent[], mimeType: string): string {
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return textFromEntries(entries, (name) =>
      name === 'word/document.xml'
      || /^word\/(header|footer|footnotes|endnotes)[0-9]*\.xml$/.test(name));
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return textFromEntries(entries, (name) =>
      name === 'xl/sharedStrings.xml'
      || /^xl\/worksheets\/sheet[0-9]+\.xml$/.test(name));
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return textFromEntries(entries, (name) =>
      /^ppt\/slides\/slide[0-9]+\.xml$/.test(name)
      || /^ppt\/notesSlides\/notesSlide[0-9]+\.xml$/.test(name));
  }

  if (
    mimeType === 'application/vnd.oasis.opendocument.text'
    || mimeType === 'application/vnd.oasis.opendocument.spreadsheet'
    || mimeType === 'application/vnd.oasis.opendocument.presentation'
  ) {
    return textFromEntries(entries, (name) => name === 'content.xml' || name === 'meta.xml');
  }

  return '';
}

export function extractOfficeAttachmentText(
  buffer: Buffer,
  mimeType: string
): OfficeExtractionResult {
  const entries = readZip(buffer);
  const text = extractTextForMime(entries, mimeType);
  return {
    text,
    metadata: {
      format: officeFormat(mimeType),
      zipEntries: entries.length,
      extractedTextChars: text.length,
    },
  };
}
