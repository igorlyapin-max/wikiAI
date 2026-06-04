export type WikiUiRoute = 'assistant' | 'admin';

export function routeFromPathname(pathname: string): WikiUiRoute {
  const parts = pathname.split('/').map((part) => part.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  return last === 'admin' ? 'admin' : 'assistant';
}

export function routeHref(route: WikiUiRoute): string {
  return route === 'admin' ? '/ai/admin' : '/ai/assistant';
}
