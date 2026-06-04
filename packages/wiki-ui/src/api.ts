export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function buildApiUrl(apiBase: string, path: string): string {
  const normalizedBase = apiBase.trim().replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as { error?: unknown; message?: unknown };
    const message = data.message ?? data.error;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  } catch {
    // Fall through to a status-based error.
  }

  return `Gateway returned HTTP ${response.status}`;
}

export async function fetchJson<T>(apiBase: string, path: string): Promise<T> {
  const response = await fetch(buildApiUrl(apiBase, path), {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new ApiRequestError(await readResponseError(response), response.status);
  }

  return (await response.json()) as T;
}
