import { useState } from 'react';

interface SearchTabProps {
  gatewayUrl: string;
}

interface SearchResult {
  id: string | number;
  pageId: number;
  title: string;
  pageUrl?: string;
  text?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeSearchResult(value: unknown, index: number): SearchResult | undefined {
  if (!isRecord(value)) return undefined;

  const pageId = readNumber(value.pageId) ?? 0;
  const title = readString(value.title) ?? `Страница ${pageId || index + 1}`;
  const rawId = value.id;

  return {
    id: typeof rawId === 'string' || typeof rawId === 'number' ? rawId : `${pageId}-${index}`,
    pageId,
    title,
    pageUrl: readString(value.pageUrl),
    text: readString(value.text),
  };
}

function normalizeSearchResults(value: unknown): SearchResult[] {
  return Array.isArray(value)
    ? value.map(normalizeSearchResult).filter((item): item is SearchResult => Boolean(item))
    : [];
}

async function readGatewayError(res: Response): Promise<string> {
  try {
    const data = (await res.clone().json()) as { error?: unknown; message?: unknown };
    const value = data.error ?? data.message;
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  } catch {
    // Fall through to a status-based message.
  }

  return `Ошибка Gateway (${res.status})`;
}

const SPINNER_KEYFRAMES = '@keyframes ai-assistant-spin { to { transform: rotate(360deg); } }';

function ProcessingIndicator({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 12,
        padding: '8px 10px',
        border: '1px solid #ddd',
        borderRadius: 4,
        color: '#111827',
        background: '#f9fafb',
        fontSize: 13,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          border: '2px solid #d1d5db',
          borderTopColor: '#111827',
          borderRadius: '50%',
          animation: 'ai-assistant-spin 0.8s linear infinite',
          flex: '0 0 auto',
        }}
      />
      <span>{label}</span>
    </div>
  );
}

export default function SearchTab({ gatewayUrl }: SearchTabProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const res = await fetch(`${gatewayUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query, topK: 5 }),
      });
      if (!res.ok) {
        throw new Error(await readGatewayError(res));
      }
      const data = await res.json();
      setResults(normalizeSearchResults(isRecord(data) ? data.results : undefined));
    } catch (err) {
      console.error('Search error:', err);
      setResults([]);
      setError(err instanceof Error && err.message ? err.message : 'Ошибка поиска.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <style>{SPINNER_KEYFRAMES}</style>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Введите вопрос..."
          style={{ flex: 1, padding: 8, fontSize: 16 }}
        />
        <button onClick={handleSearch} disabled={loading} style={{ padding: '8px 16px' }}>
          {loading ? 'Обработка...' : 'Найти'}
        </button>
      </div>
      {loading && <ProcessingIndicator label="Запрос обрабатывается..." />}
      {error && (
        <div style={{ marginTop: 12, padding: 10, border: '1px solid #DC2626', color: '#DC2626', borderRadius: 4 }}>
          {error}
        </div>
      )}
      {!loading && !error && searched && results.length === 0 && (
        <div style={{ marginTop: 12, padding: 10, border: '1px solid #ddd', color: '#555', borderRadius: 4 }}>
          Ничего не найдено
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        {results.map((r) => {
          const text = typeof r.text === 'string' ? r.text : '';
          const title = r.title || `Страница ${r.pageId}`;
          return (
            <div key={r.id} style={{ marginBottom: 12, padding: 12, border: '1px solid #ddd', borderRadius: 4 }}>
              <div style={{ fontWeight: 'bold', marginBottom: 4 }}>
                {r.pageUrl ? (
                  <a href={r.pageUrl} target="_blank" rel="noreferrer" style={{ color: '#111827' }}>
                    {title}
                  </a>
                ) : (
                  title
                )}
              </div>
              {text && <div style={{ color: '#555', fontSize: 14 }}>{text.slice(0, 300)}...</div>}
              {r.pageUrl && (
                <a
                  href={r.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-block', marginTop: 6, fontSize: 13, color: '#4a90d9' }}
                >
                  Открыть страницу
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
