import { config } from '../config.js';
import { getAdminStore } from '../db/admin-store.js';

export const SMW_ONTOLOGY_AREA = 'smw-ontology';
export const SMW_ONTOLOGY_KEY = 'properties';

interface StoredOntologyPropertyIndexState {
  name?: unknown;
  indexed?: unknown;
}

interface StoredOntologyIndexState {
  properties?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(
    values
      .map((value) => value.trim())
      .filter(Boolean)
  ));
}

function indexedPropertiesFromStore(store: StoredOntologyIndexState): string[] {
  if (!Array.isArray(store.properties)) return [];

  return uniqueStrings(
    store.properties
      .filter((item): item is StoredOntologyPropertyIndexState => isRecord(item))
      .filter((property) => property.indexed !== false)
      .map((property) => property.name)
      .filter((name): name is string => typeof name === 'string')
  );
}

export async function getIndexedSmwProperties(): Promise<string[]> {
  const store = await getAdminStore().getJson<StoredOntologyIndexState>(
    SMW_ONTOLOGY_AREA,
    SMW_ONTOLOGY_KEY
  );
  if (!store || !Array.isArray(store.properties)) {
    return uniqueStrings(config.smwSyncProperties);
  }

  return indexedPropertiesFromStore(store);
}
