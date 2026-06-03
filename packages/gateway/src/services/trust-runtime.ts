import {
  getTrustModels,
  previewTrustModel,
  TrustPreviewResult,
} from './admin-platform-config.js';
import { SearchChunk, SemanticFacts } from '../types/index.js';

const CATEGORY_PROPERTIES = ['Категория', 'Категории', 'Category', 'Categories'];
const TAG_PROPERTIES = ['Тег', 'Теги', 'Tag', 'Tags'];
const TEMPLATE_PROPERTIES = ['Шаблон', 'Шаблоны', 'Template', 'Templates'];
const AUTHOR_GROUP_PROPERTIES = ['Группа автора', 'Группы автора', 'Author group', 'Author groups'];

export function readTrustFactValues(facts: SemanticFacts | undefined, names: string[]): string[] {
  if (!facts) return [];
  const values = names.flatMap((name) => facts[name] ?? []);
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export function trustFromPreview(preview: TrustPreviewResult): SearchChunk['trust'] {
  return {
    modelId: preview.modelId,
    score: preview.score,
    lastModified: preview.lastModified,
    ageYears: preview.ageYears,
    stalenessPenalty: preview.stalenessPenalty,
    flags: preview.flags,
    appliedEntityIds: preview.appliedEntities.map((entity) => entity.id),
    appliedRuleIds: preview.appliedRules.map((rule) => rule.id),
    decisions: preview.decisions,
  };
}

export function buildTrustPreviewPayload(chunk: SearchChunk): {
  title: string;
  namespace: number;
  categories: string[];
  tags: string[];
  authorGroups: string[];
  templates: string[];
  lastModified?: string;
  properties: SemanticFacts;
} {
  return {
    title: chunk.title,
    namespace: chunk.namespace,
    categories: readTrustFactValues(chunk.semanticFacts, CATEGORY_PROPERTIES),
    tags: readTrustFactValues(chunk.semanticFacts, TAG_PROPERTIES),
    authorGroups: readTrustFactValues(chunk.semanticFacts, AUTHOR_GROUP_PROPERTIES),
    templates: readTrustFactValues(chunk.semanticFacts, TEMPLATE_PROPERTIES),
    lastModified: chunk.lastModified,
    properties: chunk.semanticFacts ?? {},
  };
}

export async function applyTrustPolicyToChunks(chunks: SearchChunk[], limit: number): Promise<SearchChunk[]> {
  const models = await getTrustModels();
  const activeModel = models.find((model) => model.active) ?? models[0];
  if (!activeModel) return chunks.slice(0, limit);

  const trustedChunks: SearchChunk[] = [];
  for (const chunk of chunks) {
    const preview = await previewTrustModel(activeModel.id, buildTrustPreviewPayload(chunk));
    const enrichedChunk: SearchChunk = { ...chunk, trust: trustFromPreview(preview) };

    if (preview.decisions.includeInContext) {
      trustedChunks.push(enrichedChunk);
    }
    if (trustedChunks.length >= limit) break;
  }

  return trustedChunks;
}
