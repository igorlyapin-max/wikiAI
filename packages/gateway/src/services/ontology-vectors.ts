import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { getAdminStore } from '../db/admin-store.js';
import { getEffectiveEmbeddingConfig } from './admin-platform-config.js';
import { getEmbedding } from './embedding.js';
import { getSemanticStatus } from './semantic-diagnostics.js';
import { SMW_ONTOLOGY_AREA, SMW_ONTOLOGY_KEY } from './smw-indexing-properties.js';

const ONTOLOGY_AREA = SMW_ONTOLOGY_AREA;
const ONTOLOGY_KEY = SMW_ONTOLOGY_KEY;
const VECTOR_SOURCE_VALUES_LIMIT = 20;
const VECTOR_SOURCE_STATUS_MAX_SCAN = 10_000;

export interface OntologyVectorState {
  status: 'missing' | 'ready';
  model?: string;
  dimension?: number;
  generatedAt?: string;
  sourceText?: string;
}

interface StoredOntologyVector extends OntologyVectorState {
  embedding?: number[];
}

export interface OntologyProperty {
  id: string;
  name: string;
  label: string;
  description: string;
  dataType: string;
  format?: string;
  unit?: string;
  indexed: boolean;
  aiExtractable: boolean;
  aiPromptHint?: string;
  classificationThreshold: number;
  sensitive: boolean;
  requiredRight?: string;
  createdAt: string;
  updatedAt: string;
  vector: OntologyVectorState;
}

interface StoredOntologyProperty extends Omit<OntologyProperty, 'vector'> {
  vector: StoredOntologyVector;
}

interface OntologyStore {
  properties: StoredOntologyProperty[];
}

export interface OntologySimilarity {
  id: string;
  name: string;
  label: string;
  similarity: number;
  vector: OntologyVectorState;
}

export interface OntologyCluster {
  id: string;
  propertyIds: string[];
  properties: Array<Pick<OntologyProperty, 'id' | 'name' | 'label'>>;
  averageSimilarity: number;
}

export interface OntologyClusterizationResult {
  threshold: number;
  clusters: OntologyCluster[];
  isolated: Array<Pick<OntologyProperty, 'id' | 'name' | 'label'>>;
}

export interface OntologyClassificationMatch {
  id: string;
  name: string;
  label: string;
  description: string;
  dataType: string;
  similarity: number;
  classificationThreshold: number;
  matched: boolean;
  sensitive: boolean;
  vector: OntologyVectorState;
}

export interface OntologyClassificationResult {
  textLength: number;
  model: string;
  dimension: number;
  threshold?: number;
  results: OntologyClassificationMatch[];
  matches: OntologyClassificationMatch[];
  diagnostics: {
    totalProperties: number;
    vectorizedProperties: number;
    eligibleProperties: number;
    skippedMissingVector: number;
    skippedNonExtractable: number;
    skippedSensitive: number;
  };
}

const ontologyPropertyInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  name: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  dataType: z.string().trim().min(1).max(120).optional(),
  format: z.string().trim().min(1).max(120).optional(),
  unit: z.string().trim().min(1).max(80).optional(),
  indexed: z.boolean().optional(),
  aiExtractable: z.boolean().optional(),
  aiPromptHint: z.string().trim().max(4000).optional(),
  classificationThreshold: z.number().min(0).max(1).optional(),
  sensitive: z.boolean().optional(),
  requiredRight: z.string().trim().min(1).max(160).optional(),
}).strict();

const ontologyClassificationInputSchema = z.object({
  text: z.string().trim().min(1).max(20000),
  limit: z.number().int().min(1).max(100).optional(),
  threshold: z.number().min(0).max(1).optional(),
  includeSensitive: z.boolean().optional(),
}).strict();

function nowIso(): string {
  return new Date().toISOString();
}

function ontologyId(name: string): string {
  return `smw-${createHash('sha1').update(name).digest('hex').slice(0, 12)}`;
}

function defaultProperty(name: string, timestamp = nowIso()): StoredOntologyProperty {
  return {
    id: ontologyId(name),
    name,
    label: name,
    description: '',
    dataType: 'text',
    indexed: true,
    aiExtractable: true,
    classificationThreshold: 0.7,
    sensitive: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    vector: { status: 'missing' },
  };
}

function publicProperty(property: StoredOntologyProperty): OntologyProperty {
  const { embedding: _embedding, ...vector } = property.vector;
  return { ...property, indexed: property.indexed !== false, vector };
}

function normalizeVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  return vector.length === value.length && vector.length > 0 ? vector : null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getKnownSemanticValues(property: StoredOntologyProperty): Promise<string[]> {
  if (property.sensitive) return [];

  try {
    const status = await getSemanticStatus({ maxScan: VECTOR_SOURCE_STATUS_MAX_SCAN });
    return (status.properties[property.name]?.values ?? []).slice(0, VECTOR_SOURCE_VALUES_LIMIT);
  } catch (_err) {
    return [];
  }
}

async function buildVectorSourceText(property: StoredOntologyProperty): Promise<string> {
  const knownValues = await getKnownSemanticValues(property);
  return [
    `SMW property: ${property.name}`,
    `Label: ${property.label}`,
    property.description ? `Description: ${property.description}` : '',
    `Data type: ${property.dataType}`,
    property.format ? `Format: ${property.format}` : '',
    property.unit ? `Unit: ${property.unit}` : '',
    property.aiPromptHint ? `AI prompt hint: ${property.aiPromptHint}` : '',
    property.sensitive
      ? 'Known values: hidden because this property is marked sensitive'
      : knownValues.length > 0
        ? `Known values sample: ${knownValues.join(', ')}`
        : '',
    property.sensitive ? 'Sensitive: yes' : 'Sensitive: no',
  ].filter(Boolean).join('\n');
}

async function createLocalEmbedding(prompt: string): Promise<{ model: string; vector: number[] }> {
  const embedding = await getEffectiveEmbeddingConfig();
  const vector = normalizeVector(await getEmbedding(prompt));
  if (!vector) throw new Error('Ontology embed response does not contain numeric embedding');

  return { model: embedding.model, vector };
}

async function getOntologyStore(): Promise<OntologyStore> {
  const stored = await getAdminStore().getJson<OntologyStore>(ONTOLOGY_AREA, ONTOLOGY_KEY);
  if (stored?.properties) return stored;

  return {
    properties: config.smwSyncProperties.map((property) => defaultProperty(property)),
  };
}

async function saveOntologyStore(store: OntologyStore, actor: string | undefined, action: string): Promise<void> {
  await getAdminStore().setJson(ONTOLOGY_AREA, ONTOLOGY_KEY, store, {
    actor,
    action,
    entityType: ONTOLOGY_AREA,
  });
}

function findStoredProperty(store: OntologyStore, id: string): StoredOntologyProperty {
  const property = store.properties.find((item) => item.id === id || item.name === id);
  if (!property) throw new Error(`Ontology property not found: ${id}`);
  return property;
}

export async function getOntologyProperties(): Promise<OntologyProperty[]> {
  const store = await getOntologyStore();
  return store.properties.map(publicProperty);
}

export async function upsertOntologyProperty(input: unknown, actor?: string): Promise<OntologyProperty> {
  const parsed = ontologyPropertyInputSchema.parse(input);
  const store = await getOntologyStore();
  const timestamp = nowIso();
  const id = parsed.id ?? ontologyId(parsed.name);
  const existingIndex = store.properties.findIndex((item) => item.id === id || item.name === parsed.name);
  const existing = existingIndex >= 0 ? store.properties[existingIndex] : undefined;

  const updated: StoredOntologyProperty = {
    ...(existing ?? defaultProperty(parsed.name, timestamp)),
    id,
    name: parsed.name,
    label: parsed.label ?? existing?.label ?? parsed.name,
    description: parsed.description ?? existing?.description ?? '',
    dataType: parsed.dataType ?? existing?.dataType ?? 'text',
    format: parsed.format ?? existing?.format,
    unit: parsed.unit ?? existing?.unit,
    indexed: parsed.indexed ?? existing?.indexed ?? true,
    aiExtractable: parsed.aiExtractable ?? existing?.aiExtractable ?? true,
    aiPromptHint: parsed.aiPromptHint ?? existing?.aiPromptHint,
    classificationThreshold: parsed.classificationThreshold ?? existing?.classificationThreshold ?? 0.7,
    sensitive: parsed.sensitive ?? existing?.sensitive ?? false,
    requiredRight: parsed.requiredRight ?? existing?.requiredRight,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    vector: existing?.vector ?? { status: 'missing' },
  };

  if (existingIndex >= 0) {
    store.properties[existingIndex] = updated;
  } else {
    store.properties.push(updated);
  }
  store.properties.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  await saveOntologyStore(store, actor, existing ? 'smw-ontology.update' : 'smw-ontology.create');
  return publicProperty(updated);
}

export async function deleteOntologyProperty(id: string, actor?: string): Promise<OntologyProperty> {
  const store = await getOntologyStore();
  const propertyIndex = store.properties.findIndex((item) => item.id === id || item.name === id);
  if (propertyIndex < 0) throw new Error(`Ontology property not found: ${id}`);

  const [deleted] = store.properties.splice(propertyIndex, 1);
  await saveOntologyStore(store, actor, 'smw-ontology.delete');
  return publicProperty(deleted);
}

export async function generateOntologyVector(id: string, actor?: string): Promise<OntologyProperty> {
  const store = await getOntologyStore();
  const property = findStoredProperty(store, id);
  const sourceText = await buildVectorSourceText(property);
  const embedding = await createLocalEmbedding(sourceText);

  property.vector = {
    status: 'ready',
    model: embedding.model,
    dimension: embedding.vector.length,
    generatedAt: nowIso(),
    sourceText,
    embedding: embedding.vector,
  };
  property.updatedAt = nowIso();

  await saveOntologyStore(store, actor, 'smw-ontology.generate-vector');
  return publicProperty(property);
}

export async function getOntologySimilarities(
  id: string,
  options: { limit?: number; threshold?: number } = {}
): Promise<{ source: OntologyProperty; results: OntologySimilarity[] }> {
  const store = await getOntologyStore();
  const source = findStoredProperty(store, id);
  if (!source.vector.embedding) throw new Error(`Ontology property has no vector: ${id}`);

  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const threshold = Math.min(Math.max(options.threshold ?? 0, 0), 1);
  const results = store.properties
    .filter((property) => property.id !== source.id && property.vector.embedding)
    .map((property) => ({
      id: property.id,
      name: property.name,
      label: property.label,
      similarity: cosineSimilarity(source.vector.embedding ?? [], property.vector.embedding ?? []),
      vector: publicProperty(property).vector,
    }))
    .filter((result) => result.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return { source: publicProperty(source), results };
}

export async function clusterizeOntologyProperties(
  input: unknown = {}
): Promise<OntologyClusterizationResult> {
  const parsed = z.object({ threshold: z.number().min(0).max(1).optional() }).strict().parse(input);
  const threshold = parsed.threshold ?? 0.82;
  const store = await getOntologyStore();
  const vectorized = store.properties.filter((property) => property.vector.embedding);
  const visited = new Set<string>();
  const clusters: OntologyCluster[] = [];

  for (const property of vectorized) {
    if (visited.has(property.id) || !property.vector.embedding) continue;
    const peers = vectorized.filter((candidate) => {
      if (candidate.id === property.id || !candidate.vector.embedding) return false;
      return cosineSimilarity(property.vector.embedding ?? [], candidate.vector.embedding) >= threshold;
    });
    if (peers.length === 0) continue;

    const members = [property, ...peers.filter((peer) => !visited.has(peer.id))];
    members.forEach((member) => visited.add(member.id));
    const similarities = members
      .filter((member) => member.id !== property.id && member.vector.embedding)
      .map((member) => cosineSimilarity(property.vector.embedding ?? [], member.vector.embedding ?? []));
    const averageSimilarity = similarities.length > 0
      ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
      : 1;

    clusters.push({
      id: `cluster-${clusters.length + 1}`,
      propertyIds: members.map((member) => member.id),
      properties: members.map((member) => ({
        id: member.id,
        name: member.name,
        label: member.label,
      })),
      averageSimilarity,
    });
  }

  const clusteredIds = new Set(clusters.flatMap((cluster) => cluster.propertyIds));
  const isolated = vectorized
    .filter((property) => !clusteredIds.has(property.id))
    .map((property) => ({ id: property.id, name: property.name, label: property.label }));

  return { threshold, clusters, isolated };
}

export async function classifyOntologyFragment(input: unknown): Promise<OntologyClassificationResult> {
  const parsed = ontologyClassificationInputSchema.parse(input);
  const store = await getOntologyStore();
  const embedding = await createLocalEmbedding(parsed.text);
  const limit = parsed.limit ?? 10;

  const vectorized = store.properties.filter((property) => property.vector.embedding);
  const eligible = vectorized.filter((property) => {
    if (property.aiExtractable === false) return false;
    if (property.sensitive && !parsed.includeSensitive) return false;
    return true;
  });

  const results = eligible
    .map((property) => {
      const propertyVector = property.vector.embedding ?? [];
      const classificationThreshold = parsed.threshold ?? property.classificationThreshold;
      const similarity = cosineSimilarity(embedding.vector, propertyVector);
      return {
        id: property.id,
        name: property.name,
        label: property.label,
        description: property.description,
        dataType: property.dataType,
        similarity,
        classificationThreshold,
        matched: similarity >= classificationThreshold,
        sensitive: property.sensitive,
        vector: publicProperty(property).vector,
      };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  const skippedNonExtractable = vectorized.filter((property) => property.aiExtractable === false).length;
  const skippedSensitive = vectorized.filter(
    (property) => property.aiExtractable !== false && property.sensitive && !parsed.includeSensitive
  ).length;

  return {
    textLength: parsed.text.length,
    model: embedding.model,
    dimension: embedding.vector.length,
    threshold: parsed.threshold,
    results,
    matches: results.filter((result) => result.matched),
    diagnostics: {
      totalProperties: store.properties.length,
      vectorizedProperties: vectorized.length,
      eligibleProperties: eligible.length,
      skippedMissingVector: store.properties.length - vectorized.length,
      skippedNonExtractable,
      skippedSensitive,
    },
  };
}
