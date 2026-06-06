import { config } from '../config.js';

export function getAllowedGroups(namespace: number, namespaceAcl: Record<string, string[]> = config.namespaceAcl): string[] {
  return namespaceAcl[String(namespace)] ?? namespaceAcl[namespace] ?? [];
}
