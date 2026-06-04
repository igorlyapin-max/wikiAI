import { z } from 'zod';
import { getAdminStore } from '../db/admin-store.js';
import { config } from '../config.js';
import { getRagAdminConfig, setRagAdminConfig } from './admin-platform-config.js';

const COLBERT_INDEX_AREA = 'colbert-indexes';
const DEFAULT_KEY = 'default';

export type ColbertIndexStatus = 'building' | 'complete' | 'failed' | 'canceled';
export type ColbertIndexSource = 'qdrant_payload' | 'mediawiki';

export interface ColbertIndexSpec {
  id: string;
  model: string;
  collection: string;
  maxTokens: number;
  device: string;
  source: ColbertIndexSource;
  sourceProfile?: string;
  status: ColbertIndexStatus;
  active: boolean;
  pagesProcessed: number;
  chunksIndexed: number;
  failures: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

const colbertIndexInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  model: z.string().trim().min(1).max(200),
  collection: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  maxTokens: z.number().int().min(32).max(4096).optional(),
  device: z.string().trim().min(1).max(40).optional(),
  source: z.enum(['qdrant_payload', 'mediawiki']).optional(),
  sourceProfile: z.string().trim().min(1).max(120).optional(),
}).strict();

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'model';
}

function indexId(model: string): string {
  return `colbert-${slug(model)}-${Date.now().toString(36)}`;
}

function collectionName(model: string): string {
  return `wiki_colbert_chunks_${slug(model)}_${Date.now().toString(36)}`.slice(0, 120);
}

async function defaultActiveIndex(): Promise<ColbertIndexSpec> {
  const rag = await getRagAdminConfig();
  const now = new Date().toISOString();
  return {
    id: 'active-runtime',
    model: rag.colbertModel || config.colbertModel,
    collection: rag.colbertCollection || config.colbertCollection,
    maxTokens: Number(process.env.COLBERT_MAX_TOKENS ?? 180),
    device: process.env.COLBERT_DEVICE ?? 'cpu',
    source: 'mediawiki',
    status: rag.colbertEnabled ? 'complete' : 'failed',
    active: rag.colbertEnabled,
    pagesProcessed: 0,
    chunksIndexed: 0,
    failures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getColbertIndexSpecs(): Promise<ColbertIndexSpec[]> {
  const stored = await getAdminStore().getJson<ColbertIndexSpec[]>(COLBERT_INDEX_AREA, DEFAULT_KEY);
  if (stored && stored.length > 0) return stored;
  return [await defaultActiveIndex()];
}

async function saveColbertIndexSpecs(
  specs: ColbertIndexSpec[],
  actor: string | undefined,
  action: string
): Promise<void> {
  await getAdminStore().setJson(COLBERT_INDEX_AREA, DEFAULT_KEY, specs, {
    actor,
    action,
    entityType: COLBERT_INDEX_AREA,
  });
}

export async function createColbertIndexSpec(input: unknown, actor?: string): Promise<ColbertIndexSpec> {
  const parsed = colbertIndexInputSchema.parse(input);
  const now = new Date().toISOString();
  const spec: ColbertIndexSpec = {
    id: parsed.id ?? indexId(parsed.model),
    model: parsed.model,
    collection: parsed.collection ?? collectionName(parsed.model),
    maxTokens: parsed.maxTokens ?? Number(process.env.COLBERT_MAX_TOKENS ?? 180),
    device: parsed.device ?? process.env.COLBERT_DEVICE ?? 'cpu',
    source: parsed.source ?? 'qdrant_payload',
    sourceProfile: parsed.sourceProfile,
    status: 'building',
    active: false,
    pagesProcessed: 0,
    chunksIndexed: 0,
    failures: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  const specs = (await getColbertIndexSpecs()).filter((item) => item.id !== spec.id);
  await saveColbertIndexSpecs([...specs, spec], actor, 'colbert-index.create');
  return spec;
}

export async function updateColbertIndexSpecStatus(
  id: string,
  update: Partial<Pick<ColbertIndexSpec, 'status' | 'pagesProcessed' | 'chunksIndexed' | 'failures' | 'error'>>,
  actor?: string
): Promise<ColbertIndexSpec> {
  const specs = await getColbertIndexSpecs();
  const existing = specs.find((item) => item.id === id);
  if (!existing) throw new Error(`ColBERT index not found: ${id}`);
  const now = new Date().toISOString();
  const updated: ColbertIndexSpec = {
    ...existing,
    ...update,
    updatedAt: now,
    completedAt: update.status === 'complete' || update.status === 'failed' || update.status === 'canceled'
      ? now
      : existing.completedAt,
  };
  await saveColbertIndexSpecs(specs.map((item) => item.id === id ? updated : item), actor, 'colbert-index.status');
  return updated;
}

export async function promoteColbertIndexSpec(id: string, actor?: string): Promise<ColbertIndexSpec> {
  const specs = await getColbertIndexSpecs();
  const existing = specs.find((item) => item.id === id);
  if (!existing) throw new Error(`ColBERT index not found: ${id}`);
  if (existing.status !== 'complete') {
    throw new Error(`ColBERT index must be complete before promote: ${id}`);
  }

  const now = new Date().toISOString();
  const promoted: ColbertIndexSpec = {
    ...existing,
    active: true,
    updatedAt: now,
  };
  await saveColbertIndexSpecs(specs.map((item) => ({
    ...item,
    active: item.id === id,
    updatedAt: item.id === id ? now : item.updatedAt,
  })), actor, 'colbert-index.promote');

  const rag = await getRagAdminConfig();
  await setRagAdminConfig({
    ...rag,
    colbertEnabled: true,
    colbertModel: promoted.model,
    colbertCollection: promoted.collection,
    colbertFailMode: 'fail_search',
  }, actor);

  return promoted;
}

export async function cancelColbertIndexSpec(id: string, actor?: string): Promise<ColbertIndexSpec> {
  return updateColbertIndexSpecStatus(id, { status: 'canceled' }, actor);
}
