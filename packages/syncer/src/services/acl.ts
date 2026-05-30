import { config } from '../config.js';

export function getAllowedGroups(namespace: number): string[] {
  return config.namespaceAcl[namespace] ?? ['*'];
}
