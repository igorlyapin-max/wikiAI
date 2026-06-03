export function getNamespacesToReindex(namespaceAcl: Record<string, string[]>): number[] {
  const namespaces = Object.keys(namespaceAcl)
    .map((key) => Number.parseInt(key, 10))
    .filter((namespace) => Number.isInteger(namespace) && namespace >= 0);

  return namespaces.length > 0 ? Array.from(new Set(namespaces)).sort((a, b) => a - b) : [0];
}
