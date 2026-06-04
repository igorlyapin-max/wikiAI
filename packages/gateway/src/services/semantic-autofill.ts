import { z } from 'zod';
import {
  getAdminPostgresStore,
  getAdminSqliteDatabase,
  getAdminStore,
  isPostgresDatabase,
} from '../db/admin-store.js';
import { callLiteLLM } from './litellm.js';
import { getOntologyProperties, OntologyProperty } from './ontology-vectors.js';

const CONFIG_AREA = 'smw-autofill-config';
const CONFIG_KEY = 'default';
const DEFAULT_TEMPLATE = 'Корпоративный документ';
const DEFAULT_MAX_PAGE_CHARS = 20_000;
const AI_SUMMARY_PREFIX = 'WikiAI semantic autofill';

export type SemanticAutofillMode = 'suggest_only' | 'apply_empty';
export type SemanticAutofillFieldState = 'auto' | 'user' | 'suggested' | 'disabled';

export interface SemanticAutofillConfig {
  enabled: boolean;
  mode: SemanticAutofillMode;
  minConfidence: number;
  templates: string[];
  namespaces: number[];
  maxPageChars: number;
}

export interface SemanticAutofillFieldRecord {
  pageId: number;
  title: string;
  property: string;
  state: SemanticAutofillFieldState;
  currentValue?: string;
  lastAiValue?: string;
  lastAiRevisionId?: number;
  lastUserRevisionId?: number;
  confidence?: number;
  reason?: string;
  evidence?: string;
  updatedAt: string;
}

export interface SemanticAutofillSuggestion {
  property: string;
  value: string;
  confidence: number;
  evidence?: string;
  state: SemanticAutofillFieldState;
}

export interface SemanticAutofillPatchItem {
  property: string;
  value: string;
  confidence: number;
  evidence?: string;
  expectedValue?: string;
}

export interface SemanticAutofillEvaluationResult {
  enabled: boolean;
  mode: SemanticAutofillMode;
  templates: string[];
  patch: SemanticAutofillPatchItem[];
  suggestions: SemanticAutofillSuggestion[];
  lockedFields: Array<{ property: string; state: SemanticAutofillFieldState; reason?: string }>;
  diagnostics: {
    skippedReason?: string;
    candidateCount: number;
    eligiblePropertyCount: number;
    llmCalled: boolean;
    error?: string;
  };
}

export interface SemanticAutofillStatus {
  summary: Record<SemanticAutofillFieldState, number>;
  total: number;
  records: SemanticAutofillFieldRecord[];
}

interface TemplateReadResult {
  found: boolean;
  templateName?: string;
  params: Record<string, string>;
}

interface UpsertFieldStateInput {
  pageId: number;
  title: string;
  property: string;
  state: SemanticAutofillFieldState;
  currentValue?: string;
  lastAiValue?: string;
  lastAiRevisionId?: number;
  lastUserRevisionId?: number;
  confidence?: number;
  reason?: string;
  evidence?: string;
}

const configUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['suggest_only', 'apply_empty']).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  templates: z.array(z.string().trim().min(1).max(160)).max(20).optional(),
  namespaces: z.array(z.number().int().min(0)).max(200).optional(),
  maxPageChars: z.number().int().min(1000).max(100_000).optional(),
}).strict();

const semanticFactsSchema = z.record(z.array(z.string().trim().min(1).max(500)).max(50));

const evaluateInputSchema = z.object({
  pageId: z.number().int().positive(),
  title: z.string().trim().min(1).max(500),
  namespace: z.number().int().min(0),
  revId: z.number().int().positive().optional(),
  editor: z.object({
    username: z.string().trim().max(160).optional(),
    userId: z.number().int().min(0).optional(),
    serviceUser: z.boolean().optional(),
  }).strict().optional(),
  summary: z.string().trim().max(1000).optional(),
  content: z.string().min(1).max(2_000_000),
  semanticFacts: semanticFactsSchema.optional(),
  force: z.boolean().optional(),
}).strict();

const appliedInputSchema = z.object({
  pageId: z.number().int().positive(),
  title: z.string().trim().min(1).max(500),
  revId: z.number().int().positive().optional(),
  fields: z.array(z.object({
    property: z.string().trim().min(1).max(160),
    value: z.string().trim().min(1).max(500),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.string().trim().max(1200).optional(),
  }).strict()).min(1).max(100),
}).strict();

const statusInputSchema = z.object({
  state: z.enum(['auto', 'user', 'suggested', 'disabled']).optional(),
  property: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict().optional();

const resetInputSchema = z.object({
  pageId: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(500).optional(),
  property: z.string().trim().min(1).max(160).optional(),
}).strict();

const llmFieldSchema = z.object({
  property: z.string().trim().min(1).max(160),
  value: z.string().trim().max(500).default(''),
  confidence: z.number().min(0).max(1).default(0),
  evidence: z.string().trim().max(1200).optional(),
}).passthrough();

const llmResponseSchema = z.object({
  fields: z.array(llmFieldSchema).max(100).default([]),
}).passthrough();

export const DEFAULT_SEMANTIC_AUTOFILL_CONFIG: SemanticAutofillConfig = {
  enabled: false,
  mode: 'suggest_only',
  minConfidence: 0.82,
  templates: [DEFAULT_TEMPLATE],
  namespaces: [],
  maxPageChars: DEFAULT_MAX_PAGE_CHARS,
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeValue(value: string | undefined): string {
  return (value ?? '').trim();
}

function rowToRecord(row: {
  page_id: number;
  title: string;
  property_name: string;
  state: string;
  current_value: string | null;
  last_ai_value: string | null;
  last_ai_revision_id: number | null;
  last_user_revision_id: number | null;
  confidence: number | null;
  reason: string | null;
  evidence: string | null;
  updated_at: Date | string;
}): SemanticAutofillFieldRecord {
  return {
    pageId: row.page_id,
    title: row.title,
    property: row.property_name,
    state: isFieldState(row.state) ? row.state : 'auto',
    currentValue: row.current_value ?? undefined,
    lastAiValue: row.last_ai_value ?? undefined,
    lastAiRevisionId: row.last_ai_revision_id ?? undefined,
    lastUserRevisionId: row.last_user_revision_id ?? undefined,
    confidence: row.confidence ?? undefined,
    reason: row.reason ?? undefined,
    evidence: row.evidence ?? undefined,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function isFieldState(value: string): value is SemanticAutofillFieldState {
  return value === 'auto' || value === 'user' || value === 'suggested' || value === 'disabled';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTemplateParameters(content: string, templateNames: string[]): TemplateReadResult {
  for (const templateName of templateNames) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(templateName)}(?=[\\s|])([\\s\\S]*?)\\n?\\}\\}`, 'i');
    const match = pattern.exec(content);
    if (!match) continue;

    const params: Record<string, string> = {};
    const lines = match[1].split(/\r?\n/);
    for (const line of lines) {
      const paramMatch = /^\s*\|\s*([^=]+?)\s*=\s*(.*)\s*$/.exec(line);
      if (!paramMatch) continue;
      params[paramMatch[1].trim()] = paramMatch[2].trim();
    }

    return { found: true, templateName, params };
  }

  return { found: false, params: {} };
}

function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('LLM response does not contain JSON object');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function formatKnownFacts(semanticFacts: Record<string, string[]> | undefined): string {
  if (!semanticFacts) return '';
  return Object.entries(semanticFacts)
    .filter(([, values]) => values.length > 0)
    .sort(([left], [right]) => left.localeCompare(right, 'ru'))
    .map(([property, values]) => `${property}: ${values.join(', ')}`)
    .join('\n');
}

function buildExtractionPrompt(input: {
  title: string;
  content: string;
  semanticFacts?: Record<string, string[]>;
  properties: OntologyProperty[];
  maxPageChars: number;
}): Array<{ role: string; content: string }> {
  const properties = input.properties.map((property) => [
    `- ${property.name}`,
    property.description ? `description: ${property.description}` : '',
    property.dataType ? `type: ${property.dataType}` : '',
    property.aiPromptHint ? `hint: ${property.aiPromptHint}` : '',
  ].filter(Boolean).join('; ')).join('\n');
  const facts = formatKnownFacts(input.semanticFacts);
  const text = input.content.slice(0, input.maxPageChars);

  return [
    {
      role: 'system',
      content: [
        'Ты извлекаешь значения SMW-свойств из корпоративной wiki-страницы.',
        'Верни только JSON: {"fields":[{"property":"...","value":"...","confidence":0.0,"evidence":"..."}]}.',
        'Используй только перечисленные property names.',
        'Не выдумывай значение: если уверенность ниже 0.5 или данных нет, верни пустое fields или низкую confidence.',
        'value должен быть коротким значением свойства, не пересказом документа.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Title: ${input.title}`,
        facts ? `Already known semantic facts:\n${facts}` : '',
        `Properties to fill:\n${properties}`,
        `Page wikitext:\n${text}`,
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

async function loadFieldState(pageId: number): Promise<Map<string, SemanticAutofillFieldRecord>> {
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    const rows = (await pg.query<Parameters<typeof rowToRecord>[0]>(
      `SELECT page_id, title, property_name, state, current_value, last_ai_value,
              last_ai_revision_id, last_user_revision_id, confidence, reason, evidence, updated_at
         FROM ai_smw_autofill_fields
        WHERE page_id = $1`,
      [pageId]
    )).rows;
    return new Map(rows.map((row) => {
      const record = rowToRecord(row);
      return [record.property, record];
    }));
  }
  const db = getAdminSqliteDatabase();
  const rows = db
    .prepare(
      `SELECT page_id, title, property_name, state, current_value, last_ai_value,
              last_ai_revision_id, last_user_revision_id, confidence, reason, evidence, updated_at
         FROM ai_smw_autofill_fields
        WHERE page_id = ?`
    )
    .all(pageId) as Array<Parameters<typeof rowToRecord>[0]>;
  return new Map(rows.map((row) => {
    const record = rowToRecord(row);
    return [record.property, record];
  }));
}

async function upsertFieldState(input: UpsertFieldStateInput): Promise<SemanticAutofillFieldRecord> {
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    const updatedAt = nowIso();
    await pg.query(
      `INSERT INTO ai_smw_autofill_fields
         (page_id, property_name, title, state, current_value, last_ai_value,
          last_ai_revision_id, last_user_revision_id, confidence, reason, evidence, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT(page_id, property_name) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         current_value = excluded.current_value,
         last_ai_value = COALESCE(excluded.last_ai_value, ai_smw_autofill_fields.last_ai_value),
         last_ai_revision_id = COALESCE(excluded.last_ai_revision_id, ai_smw_autofill_fields.last_ai_revision_id),
         last_user_revision_id = COALESCE(excluded.last_user_revision_id, ai_smw_autofill_fields.last_user_revision_id),
         confidence = excluded.confidence,
         reason = excluded.reason,
         evidence = excluded.evidence,
         updated_at = excluded.updated_at`,
      [
        input.pageId,
        input.property,
        input.title,
        input.state,
        input.currentValue ?? null,
        input.lastAiValue ?? null,
        input.lastAiRevisionId ?? null,
        input.lastUserRevisionId ?? null,
        input.confidence ?? null,
        input.reason ?? null,
        input.evidence ?? null,
        updatedAt,
      ]
    );
    return {
      pageId: input.pageId,
      title: input.title,
      property: input.property,
      state: input.state,
      currentValue: input.currentValue,
      lastAiValue: input.lastAiValue,
      lastAiRevisionId: input.lastAiRevisionId,
      lastUserRevisionId: input.lastUserRevisionId,
      confidence: input.confidence,
      reason: input.reason,
      evidence: input.evidence,
      updatedAt,
    };
  }
  const db = getAdminSqliteDatabase();
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO ai_smw_autofill_fields
       (page_id, property_name, title, state, current_value, last_ai_value,
        last_ai_revision_id, last_user_revision_id, confidence, reason, evidence, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(page_id, property_name) DO UPDATE SET
       title = excluded.title,
       state = excluded.state,
       current_value = excluded.current_value,
       last_ai_value = COALESCE(excluded.last_ai_value, ai_smw_autofill_fields.last_ai_value),
       last_ai_revision_id = COALESCE(excluded.last_ai_revision_id, ai_smw_autofill_fields.last_ai_revision_id),
       last_user_revision_id = COALESCE(excluded.last_user_revision_id, ai_smw_autofill_fields.last_user_revision_id),
       confidence = excluded.confidence,
       reason = excluded.reason,
       evidence = excluded.evidence,
       updated_at = excluded.updated_at`
  ).run(
    input.pageId,
    input.property,
    input.title,
    input.state,
    input.currentValue ?? null,
    input.lastAiValue ?? null,
    input.lastAiRevisionId ?? null,
    input.lastUserRevisionId ?? null,
    input.confidence ?? null,
    input.reason ?? null,
    input.evidence ?? null,
    updatedAt
  );
  return {
    pageId: input.pageId,
    title: input.title,
    property: input.property,
    state: input.state,
    currentValue: input.currentValue,
    lastAiValue: input.lastAiValue,
    lastAiRevisionId: input.lastAiRevisionId,
    lastUserRevisionId: input.lastUserRevisionId,
    confidence: input.confidence,
    reason: input.reason,
    evidence: input.evidence,
    updatedAt,
  };
}

async function saveAudit(action: string, entityId: string, value: unknown, actor?: string): Promise<void> {
  await getAdminStore().appendAuditLog({
    actor,
    action,
    entityType: 'smw-autofill',
    entityId,
    newValue: value,
  });
}

export async function getSemanticAutofillConfig(): Promise<SemanticAutofillConfig> {
  const stored = await getAdminStore().getJson<Partial<SemanticAutofillConfig>>(CONFIG_AREA, CONFIG_KEY);
  return {
    ...DEFAULT_SEMANTIC_AUTOFILL_CONFIG,
    ...(stored ?? {}),
    templates: stored?.templates?.length ? stored.templates : DEFAULT_SEMANTIC_AUTOFILL_CONFIG.templates,
    namespaces: stored?.namespaces ?? DEFAULT_SEMANTIC_AUTOFILL_CONFIG.namespaces,
  };
}

export async function setSemanticAutofillConfig(input: unknown, actor?: string): Promise<SemanticAutofillConfig> {
  const patch = configUpdateSchema.parse(input);
  const current = await getSemanticAutofillConfig();
  const updated: SemanticAutofillConfig = {
    ...current,
    ...patch,
    templates: patch.templates?.length ? patch.templates : current.templates,
    namespaces: patch.namespaces ?? current.namespaces,
  };
  await getAdminStore().setJson(CONFIG_AREA, CONFIG_KEY, updated, {
    actor,
    action: 'smw-autofill.config.update',
    entityType: 'smw-autofill',
  });
  return updated;
}

export async function getSemanticAutofillStatus(input?: unknown): Promise<SemanticAutofillStatus> {
  const parsed = statusInputSchema.parse(input);
  const limit = parsed?.limit ?? 100;
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (parsed?.state) {
    conditions.push(isPostgresDatabase() ? `state = $${params.length + 1}` : 'state = ?');
    params.push(parsed.state);
  }
  if (parsed?.property) {
    conditions.push(isPostgresDatabase() ? `property_name = $${params.length + 1}` : 'property_name = ?');
    params.push(parsed.property);
  }
  if (parsed?.title) {
    conditions.push(isPostgresDatabase() ? `title ILIKE $${params.length + 1}` : 'title LIKE ?');
    params.push(`%${parsed.title}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    const limitParam = params.length + 1;
    const records = (await pg.query<Parameters<typeof rowToRecord>[0]>(
      `SELECT page_id, title, property_name, state, current_value, last_ai_value,
              last_ai_revision_id, last_user_revision_id, confidence, reason, evidence, updated_at
         FROM ai_smw_autofill_fields
         ${where}
        ORDER BY updated_at DESC
        LIMIT $${limitParam}`,
      [...params, limit]
    )).rows;
    const summaryRows = (await pg.query<{ state: string; count: string | number }>(
      'SELECT state, COUNT(*) AS count FROM ai_smw_autofill_fields GROUP BY state'
    )).rows;
    const summary: Record<SemanticAutofillFieldState, number> = {
      auto: 0,
      user: 0,
      suggested: 0,
      disabled: 0,
    };
    for (const row of summaryRows) {
      if (isFieldState(row.state)) summary[row.state] = Number(row.count);
    }

    return {
      summary,
      total: summary.auto + summary.user + summary.suggested + summary.disabled,
      records: records.map(rowToRecord),
    };
  }
  const db = getAdminSqliteDatabase();
  const records = db
    .prepare(
      `SELECT page_id, title, property_name, state, current_value, last_ai_value,
              last_ai_revision_id, last_user_revision_id, confidence, reason, evidence, updated_at
         FROM ai_smw_autofill_fields
         ${where}
        ORDER BY updated_at DESC
        LIMIT ?`
    )
    .all(...params, limit) as Array<Parameters<typeof rowToRecord>[0]>;
  const summaryRows = db
    .prepare('SELECT state, COUNT(*) AS count FROM ai_smw_autofill_fields GROUP BY state')
    .all() as Array<{ state: string; count: number }>;
  const summary: Record<SemanticAutofillFieldState, number> = {
    auto: 0,
    user: 0,
    suggested: 0,
    disabled: 0,
  };
  for (const row of summaryRows) {
    if (isFieldState(row.state)) summary[row.state] = row.count;
  }

  return {
    summary,
    total: summary.auto + summary.user + summary.suggested + summary.disabled,
    records: records.map(rowToRecord),
  };
}

export async function resetSemanticAutofillOwnership(input: unknown, actor?: string): Promise<{ updated: number }> {
  const parsed = resetInputSchema.parse(input);
  if (!parsed.pageId && !parsed.title && !parsed.property) {
    throw new Error('At least one of pageId, title or property is required');
  }

  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (parsed.pageId) {
    conditions.push(isPostgresDatabase() ? `page_id = $${params.length + 2}` : 'page_id = ?');
    params.push(parsed.pageId);
  }
  if (parsed.title) {
    conditions.push(isPostgresDatabase() ? `title = $${params.length + 2}` : 'title = ?');
    params.push(parsed.title);
  }
  if (parsed.property) {
    conditions.push(isPostgresDatabase() ? `property_name = $${params.length + 2}` : 'property_name = ?');
    params.push(parsed.property);
  }

  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    const result = await pg.query(
      `UPDATE ai_smw_autofill_fields
          SET state = 'auto',
              last_ai_value = COALESCE(last_ai_value, current_value),
              reason = 'ownership_reset',
              updated_at = $1
        WHERE ${conditions.join(' AND ')}`,
      [nowIso(), ...params]
    );
    const updated = Number(result.rowCount ?? 0);
    await saveAudit('smw-autofill.ownership.reset', parsed.property ?? parsed.title ?? String(parsed.pageId), {
      ...parsed,
      updated,
    }, actor);
    return { updated };
  }

  const db = getAdminSqliteDatabase();
  const result = db
    .prepare(
      `UPDATE ai_smw_autofill_fields
          SET state = 'auto',
              last_ai_value = COALESCE(last_ai_value, current_value),
              reason = 'ownership_reset',
              updated_at = ?
        WHERE ${conditions.join(' AND ')}`
    )
    .run(nowIso(), ...params);
  const updated = Number(result.changes ?? 0);
  await saveAudit('smw-autofill.ownership.reset', parsed.property ?? parsed.title ?? String(parsed.pageId), {
    ...parsed,
    updated,
  }, actor);
  return { updated };
}

function eligibleProperties(properties: OntologyProperty[]): OntologyProperty[] {
  return properties.filter((property) =>
    property.indexed !== false &&
    property.aiExtractable !== false &&
    property.sensitive !== true
  );
}

function isServiceEdit(input: z.infer<typeof evaluateInputSchema>): boolean {
  return Boolean(input.editor?.serviceUser || input.summary?.startsWith(AI_SUMMARY_PREFIX));
}

export async function evaluateSemanticAutofill(input: unknown): Promise<SemanticAutofillEvaluationResult> {
  const parsed = evaluateInputSchema.parse(input);
  const config = await getSemanticAutofillConfig();
  const enabled = parsed.force ? true : config.enabled;
  if (!enabled) {
    return {
      enabled: false,
      mode: config.mode,
      templates: config.templates,
      patch: [],
      suggestions: [],
      lockedFields: [],
      diagnostics: {
        skippedReason: 'disabled',
        candidateCount: 0,
        eligiblePropertyCount: 0,
        llmCalled: false,
      },
    };
  }
  if (config.namespaces.length > 0 && !config.namespaces.includes(parsed.namespace)) {
    return {
      enabled: true,
      mode: config.mode,
      templates: config.templates,
      patch: [],
      suggestions: [],
      lockedFields: [],
      diagnostics: {
        skippedReason: 'namespace_not_enabled',
        candidateCount: 0,
        eligiblePropertyCount: 0,
        llmCalled: false,
      },
    };
  }

  const template = readTemplateParameters(parsed.content, config.templates);
  if (!template.found) {
    return {
      enabled: true,
      mode: config.mode,
      templates: config.templates,
      patch: [],
      suggestions: [],
      lockedFields: [],
      diagnostics: {
        skippedReason: 'template_not_found',
        candidateCount: 0,
        eligiblePropertyCount: 0,
        llmCalled: false,
      },
    };
  }

  const serviceEdit = isServiceEdit(parsed);
  if (serviceEdit) {
    return {
      enabled: true,
      mode: config.mode,
      templates: config.templates,
      patch: [],
      suggestions: [],
      lockedFields: [],
      diagnostics: {
        skippedReason: 'service_edit',
        candidateCount: 0,
        eligiblePropertyCount: 0,
        llmCalled: false,
      },
    };
  }

  const properties = eligibleProperties(await getOntologyProperties());
  const states = await loadFieldState(parsed.pageId);
  const candidates: OntologyProperty[] = [];
  const lockedFields: SemanticAutofillEvaluationResult['lockedFields'] = [];

  for (const property of properties) {
    const currentValue = normalizeValue(template.params[property.name]);
    const state = states.get(property.name);

    if (state?.state === 'disabled' || state?.state === 'user') {
      lockedFields.push({ property: property.name, state: state.state, reason: state.reason });
      continue;
    }

    if (currentValue && (!state?.lastAiValue || currentValue !== state.lastAiValue)) {
      const record = await upsertFieldState({
        pageId: parsed.pageId,
        title: parsed.title,
        property: property.name,
        state: 'user',
        currentValue,
        lastUserRevisionId: parsed.revId,
        confidence: state?.confidence,
        reason: 'manual_value',
      });
      lockedFields.push({ property: property.name, state: record.state, reason: record.reason });
      continue;
    }

    if (!currentValue && state?.lastAiValue) {
      const record = await upsertFieldState({
        pageId: parsed.pageId,
        title: parsed.title,
        property: property.name,
        state: 'user',
        currentValue,
        lastAiValue: state.lastAiValue,
        lastUserRevisionId: parsed.revId,
        confidence: state.confidence,
        reason: 'manual_clear',
      });
      lockedFields.push({ property: property.name, state: record.state, reason: record.reason });
      continue;
    }

    if (!currentValue) {
      candidates.push(property);
    }
  }

  if (candidates.length === 0) {
    return {
      enabled: true,
      mode: config.mode,
      templates: config.templates,
      patch: [],
      suggestions: [],
      lockedFields,
      diagnostics: {
        skippedReason: 'no_empty_auto_fields',
        candidateCount: 0,
        eligiblePropertyCount: properties.length,
        llmCalled: false,
      },
    };
  }

  try {
    const response = await callLiteLLM(buildExtractionPrompt({
      title: parsed.title,
      content: parsed.content,
      semanticFacts: parsed.semanticFacts,
      properties: candidates,
      maxPageChars: config.maxPageChars,
    }));
    const content = response.choices?.[0]?.message?.content ?? '';
    const llm = llmResponseSchema.parse(extractJsonObject(content));
    const candidateNames = new Set(candidates.map((property) => property.name));
    const suggestions: SemanticAutofillSuggestion[] = [];
    const patch: SemanticAutofillPatchItem[] = [];

    for (const field of llm.fields) {
      if (!candidateNames.has(field.property)) continue;
      const value = normalizeValue(field.value);
      if (!value) continue;
      const suggestion: SemanticAutofillSuggestion = {
        property: field.property,
        value,
        confidence: field.confidence,
        evidence: field.evidence,
        state: 'suggested',
      };
      suggestions.push(suggestion);
      await upsertFieldState({
        pageId: parsed.pageId,
        title: parsed.title,
        property: field.property,
        state: 'suggested',
        currentValue: '',
        confidence: field.confidence,
        reason: field.confidence >= config.minConfidence ? 'suggested_ready' : 'low_confidence',
        evidence: field.evidence,
      });

      if (config.mode === 'apply_empty' && field.confidence >= config.minConfidence) {
        patch.push({
          property: field.property,
          value,
          confidence: field.confidence,
          evidence: field.evidence,
          expectedValue: '',
        });
      }
    }

    return {
      enabled: true,
      mode: config.mode,
      templates: config.templates,
      patch,
      suggestions,
      lockedFields,
      diagnostics: {
        candidateCount: candidates.length,
        eligiblePropertyCount: properties.length,
        llmCalled: true,
      },
    };
  } catch (err) {
    return {
      enabled: true,
      mode: config.mode,
      templates: config.templates,
      patch: [],
      suggestions: [],
      lockedFields,
      diagnostics: {
        candidateCount: candidates.length,
        eligiblePropertyCount: properties.length,
        llmCalled: true,
        error: err instanceof Error ? err.message : 'Unknown semantic autofill error',
      },
    };
  }
}

export async function recordSemanticAutofillApplied(input: unknown): Promise<{ updated: number }> {
  const parsed = appliedInputSchema.parse(input);
  for (const field of parsed.fields) {
    await upsertFieldState({
      pageId: parsed.pageId,
      title: parsed.title,
      property: field.property,
      state: 'auto',
      currentValue: field.value,
      lastAiValue: field.value,
      lastAiRevisionId: parsed.revId,
      confidence: field.confidence,
      reason: 'applied',
      evidence: field.evidence,
    });
  }
  await saveAudit('smw-autofill.applied', `${parsed.pageId}`, parsed);
  return { updated: parsed.fields.length };
}
