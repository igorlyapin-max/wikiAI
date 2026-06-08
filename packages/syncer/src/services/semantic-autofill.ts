import type {
  SemanticAutofillManagedBlockConfig,
  SemanticAutofillPatchItem,
} from './gateway.js';

export interface AppliedSemanticAutofillField {
  property: string;
  value: string;
  confidence?: number;
  evidence?: string;
}

export interface SemanticAutofillPatchResult {
  changed: boolean;
  content: string;
  applied: AppliedSemanticAutofillField[];
  skipped: Array<{ property: string; reason: string }>;
}

interface TemplateMatch {
  templateName: string;
  start: number;
  end: number;
  text: string;
}

interface SemanticAutofillPatchOptions {
  writeTarget?: 'managed_block' | 'template_params';
  templates: string[];
  managedBlock?: SemanticAutofillManagedBlockConfig;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findTemplate(content: string, templateNames: string[]): TemplateMatch | null {
  for (const templateName of templateNames) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(templateName)}(?=[\\s|])[\\s\\S]*?\\n?\\}\\}`, 'i');
    const match = pattern.exec(content);
    if (!match || match.index === undefined) continue;
    return {
      templateName,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    };
  }
  return null;
}

function readParamValue(templateText: string, property: string): string | undefined {
  const pattern = new RegExp(`(^|\\n)([ \\t]*\\|[ \\t]*${escapeRegExp(property)}[ \\t]*=[ \\t]*)([^\\n]*)`, 'u');
  const match = pattern.exec(templateText);
  return match ? match[3].trim() : undefined;
}

function setParamValue(templateText: string, property: string, value: string): string {
  const pattern = new RegExp(`(^|\\n)([ \\t]*\\|[ \\t]*${escapeRegExp(property)}[ \\t]*=[ \\t]*)([^\\n]*)`, 'u');
  if (pattern.test(templateText)) {
    return templateText.replace(pattern, (_full, prefix: string, before: string) => `${prefix}${before}${value}`);
  }
  return templateText.replace(/\n?\}\}\s*$/u, `\n|${property}=${value}\n}}`);
}

function readTemplateParams(templateText: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const line of templateText.split(/\r?\n/u)) {
    const match = /^\s*\|\s*([^=]+?)\s*=\s*(.*)\s*$/u.exec(line);
    if (match) params.set(match[1].trim(), match[2].trim());
  }
  return params;
}

function sanitizeParamValue(value: string): string {
  return value.replace(/\r?\n/gu, ' ').trim();
}

function renderManagedBlock(
  params: Map<string, string>,
  managedBlock: SemanticAutofillManagedBlockConfig
): string {
  const metadata = JSON.stringify({ version: 1, profile: managedBlock.profile });
  const lines = [
    `<!-- WikiAI:semantic:start ${metadata} -->`,
    `{{${managedBlock.templateName}`,
  ];
  for (const [property, value] of params) {
    lines.push(`|${property}=${sanitizeParamValue(value)}`);
  }
  lines.push('}}', '<!-- WikiAI:semantic:end -->');
  return lines.join('\n');
}

function findManagedBlock(content: string): {
  status: 'missing' | 'found' | 'corrupt';
  start?: number;
  end?: number;
  innerStart?: number;
  innerEnd?: number;
} {
  const startPattern = /<!--\s*WikiAI:semantic:start(?:\s+\{[\s\S]*?\})?\s*-->/g;
  const endPattern = /<!--\s*WikiAI:semantic:end\s*-->/g;
  const starts = Array.from(content.matchAll(startPattern));
  const ends = Array.from(content.matchAll(endPattern));
  if (starts.length === 0 && ends.length === 0) return { status: 'missing' };
  if (starts.length !== 1 || ends.length !== 1) return { status: 'corrupt' };

  const startMatch = starts[0];
  const endMatch = ends[0];
  const start = startMatch.index ?? -1;
  const innerStart = start + startMatch[0].length;
  const innerEnd = endMatch.index ?? -1;
  const end = innerEnd + endMatch[0].length;
  if (start < 0 || innerStart > innerEnd || end <= start) return { status: 'corrupt' };
  return { status: 'found', start, end, innerStart, innerEnd };
}

function appendManagedBlock(content: string, blockText: string): string {
  const trimmedEnd = content.replace(/\s+$/u, '');
  return `${trimmedEnd}${trimmedEnd ? '\n\n' : ''}${blockText}\n`;
}

function applyTemplateParamsPatch(
  content: string,
  patch: SemanticAutofillPatchItem[],
  templateNames: string[]
): SemanticAutofillPatchResult {
  const template = findTemplate(content, templateNames);
  if (!template) {
    return {
      changed: false,
      content,
      applied: [],
      skipped: patch.map((item) => ({ property: item.property, reason: 'template_not_found' })),
    };
  }

  let templateText = template.text;
  const applied: AppliedSemanticAutofillField[] = [];
  const skipped: SemanticAutofillPatchResult['skipped'] = [];

  for (const item of patch) {
    const current = readParamValue(templateText, item.property);
    const expected = (item.expectedValue ?? '').trim();
    if ((current ?? '').trim() !== expected) {
      skipped.push({ property: item.property, reason: 'current_value_changed' });
      continue;
    }

    templateText = setParamValue(templateText, item.property, item.value);
    applied.push({
      property: item.property,
      value: item.value,
      confidence: item.confidence,
      evidence: item.evidence,
    });
  }

  if (applied.length === 0) {
    return { changed: false, content, applied, skipped };
  }

  return {
    changed: true,
    content: `${content.slice(0, template.start)}${templateText}${content.slice(template.end)}`,
    applied,
    skipped,
  };
}

function applyManagedBlockPatch(
  content: string,
  patch: SemanticAutofillPatchItem[],
  managedBlock: SemanticAutofillManagedBlockConfig
): SemanticAutofillPatchResult {
  const block = findManagedBlock(content);
  if (block.status === 'corrupt') {
    return {
      changed: false,
      content,
      applied: [],
      skipped: patch.map((item) => ({ property: item.property, reason: 'managed_block_corrupt' })),
    };
  }

  const params = new Map<string, string>();
  if (
    block.status === 'found' &&
    block.innerStart !== undefined &&
    block.innerEnd !== undefined
  ) {
    const blockText = content.slice(block.innerStart, block.innerEnd);
    const template = findTemplate(blockText, [managedBlock.templateName]);
    if (!template) {
      return {
        changed: false,
        content,
        applied: [],
        skipped: patch.map((item) => ({ property: item.property, reason: 'managed_block_corrupt' })),
      };
    }
    for (const [property, value] of readTemplateParams(template.text)) {
      params.set(property, value);
    }
  }

  const applied: AppliedSemanticAutofillField[] = [];
  const skipped: SemanticAutofillPatchResult['skipped'] = [];
  for (const item of patch) {
    const current = (params.get(item.property) ?? '').trim();
    const expected = (item.expectedValue ?? '').trim();
    if (current !== expected) {
      skipped.push({ property: item.property, reason: 'current_value_changed' });
      continue;
    }
    params.set(item.property, item.value);
    applied.push({
      property: item.property,
      value: item.value,
      confidence: item.confidence,
      evidence: item.evidence,
    });
  }

  if (applied.length === 0) {
    return { changed: false, content, applied, skipped };
  }

  const blockText = renderManagedBlock(params, managedBlock);
  if (
    block.status === 'found' &&
    block.start !== undefined &&
    block.end !== undefined
  ) {
    return {
      changed: true,
      content: `${content.slice(0, block.start)}${blockText}${content.slice(block.end)}`,
      applied,
      skipped,
    };
  }

  return {
    changed: true,
    content: appendManagedBlock(content, blockText),
    applied,
    skipped,
  };
}

export function applySemanticAutofillPatch(
  content: string,
  patch: SemanticAutofillPatchItem[],
  optionsOrTemplates: SemanticAutofillPatchOptions | string[]
): SemanticAutofillPatchResult {
  const options = Array.isArray(optionsOrTemplates)
    ? { writeTarget: 'template_params' as const, templates: optionsOrTemplates }
    : optionsOrTemplates;
  if (options.writeTarget === 'managed_block') {
    const managedBlock = options.managedBlock ?? {
      templateName: 'WikiAI Semantic',
      profile: 'default',
      insertPosition: 'end' as const,
    };
    return applyManagedBlockPatch(content, patch, managedBlock);
  }
  return applyTemplateParamsPatch(content, patch, options.templates);
}
