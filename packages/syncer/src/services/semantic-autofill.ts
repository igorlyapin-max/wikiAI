import type { SemanticAutofillPatchItem } from './gateway.js';

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

export function applySemanticAutofillPatch(
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
