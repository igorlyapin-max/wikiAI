import { useEffect, useState } from 'react';
import {
  SearchRetrievalDiagnostics,
  normalizeRetrievalDiagnostics,
  type RetrievalDiagnostics,
} from './RetrievalDiagnostics';

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

interface AssistantUiConfig {
  searchHistoryEnabled: boolean;
  searchHistoryLimit: number;
}

const DEFAULT_UI_CONFIG: AssistantUiConfig = {
  searchHistoryEnabled: true,
  searchHistoryLimit: 8,
};

const SEARCH_HISTORY_KEY = 'wikiai:searchHistory:v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizePlainSegment(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    apos: "'",
  };
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized.startsWith('#x')) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      if (normalized.startsWith('#')) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      return entities[normalized] ?? match;
    })
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*)?>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeSearchResult(value: unknown, index: number): SearchResult | undefined {
  if (!isRecord(value)) return undefined;

  const pageId = readNumber(value.pageId) ?? 0;
  const title = readString(value.title) ?? `Страница ${pageId || index + 1}`;
  const rawId = value.id;
  const text = readString(value.text);

  return {
    id: typeof rawId === 'string' || typeof rawId === 'number' ? rawId : `${pageId}-${index}`,
    pageId,
    title,
    pageUrl: readString(value.pageUrl),
    text: text ? normalizePlainSegment(text) : undefined,
  };
}

function normalizeSearchResults(value: unknown): SearchResult[] {
  return Array.isArray(value)
    ? value.map(normalizeSearchResult).filter((item): item is SearchResult => Boolean(item))
    : [];
}

function normalizeUiConfig(value: unknown): AssistantUiConfig {
  const values = isRecord(value) && isRecord(value.values) ? value.values : {};
  const limit = readNumber(values.searchHistoryLimit);
  return {
    searchHistoryEnabled: typeof values.searchHistoryEnabled === 'boolean'
      ? values.searchHistoryEnabled
      : DEFAULT_UI_CONFIG.searchHistoryEnabled,
    searchHistoryLimit: limit && Number.isInteger(limit) && limit >= 1 && limit <= 20
      ? limit
      : DEFAULT_UI_CONFIG.searchHistoryLimit,
  };
}

function readStoredHistory(limit: number): string[] {
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, limit);
  } catch {
    return [];
  }
}

function writeStoredHistory(values: string[]): void {
  try {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(values));
  } catch {
    // Ignore browser storage failures; search itself must remain usable.
  }
}

function clearStoredHistory(): void {
  try {
    window.localStorage.removeItem(SEARCH_HISTORY_KEY);
  } catch {
    // Ignore browser storage failures.
  }
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

function ProcessingIndicator({ label }: { label: string }) {
  return (
    <div className="ai-assistant__status" role="status" aria-live="polite">
      <span aria-hidden="true" className="ai-assistant__spinner" />
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
  const [uiConfig, setUiConfig] = useState<AssistantUiConfig>(DEFAULT_UI_CONFIG);
  const [history, setHistory] = useState<string[]>(() => readStoredHistory(DEFAULT_UI_CONFIG.searchHistoryLimit));
  const [diagnostics, setDiagnostics] = useState<RetrievalDiagnostics | undefined>();

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async (): Promise<void> => {
      try {
        const res = await fetch(`${gatewayUrl}/api/ui/config`, { credentials: 'include' });
        if (!res.ok) throw new Error(await readGatewayError(res));
        const nextConfig = normalizeUiConfig(await res.json());
        if (cancelled) return;
        setUiConfig(nextConfig);
        if (nextConfig.searchHistoryEnabled) {
          setHistory(readStoredHistory(nextConfig.searchHistoryLimit));
        } else {
          clearStoredHistory();
          setHistory([]);
        }
      } catch {
        if (!cancelled) {
          setUiConfig(DEFAULT_UI_CONFIG);
          setHistory(readStoredHistory(DEFAULT_UI_CONFIG.searchHistoryLimit));
        }
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, [gatewayUrl]);

  const rememberQuery = (value: string): void => {
    if (!uiConfig.searchHistoryEnabled) {
      clearStoredHistory();
      setHistory([]);
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = [
      trimmed,
      ...history.filter((item) => item.toLocaleLowerCase('ru-RU') !== trimmed.toLocaleLowerCase('ru-RU')),
    ].slice(0, uiConfig.searchHistoryLimit);
    setHistory(normalized);
    writeStoredHistory(normalized);
  };

  const handleSearch = async (nextQuery = query): Promise<void> => {
    const trimmedQuery = nextQuery.trim();
    if (!trimmedQuery) return;
    setQuery(trimmedQuery);
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const res = await fetch(`${gatewayUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query: trimmedQuery, topK: 5 }),
      });
      if (!res.ok) {
        throw new Error(await readGatewayError(res));
      }
      const data = await res.json();
      setResults(normalizeSearchResults(isRecord(data) ? data.results : undefined));
      setDiagnostics(normalizeRetrievalDiagnostics(isRecord(data) ? data.diagnostics : undefined));
      rememberQuery(trimmedQuery);
    } catch (err) {
      console.error('Search error:', err);
      setResults([]);
      setDiagnostics(undefined);
      setError(err instanceof Error && err.message ? err.message : 'Ошибка поиска.');
    } finally {
      setLoading(false);
    }
  };

  const handleClearHistory = (): void => {
    clearStoredHistory();
    setHistory([]);
  };

  return (
    <div className="ai-assistant__search">
      <div className="ai-assistant__search-bar">
        <input
          className="ai-assistant__input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSearch();
          }}
          placeholder="Введите вопрос..."
        />
        <button
          className="ai-assistant__button ai-assistant__button--primary"
          type="button"
          onClick={() => void handleSearch()}
          disabled={loading}
        >
          {loading ? 'Обработка...' : 'Найти'}
        </button>
      </div>

      {uiConfig.searchHistoryEnabled && history.length > 0 && (
        <div className="ai-assistant__history" aria-label="Последние поисковые запросы">
          <span className="ai-assistant__history-label">Последние:</span>
          {history.map((item) => (
            <button
              key={item}
              type="button"
              className="ai-assistant__chip"
              title={item}
              aria-label={`Повторить поиск: ${item}`}
              onClick={() => void handleSearch(item)}
              disabled={loading}
            >
              {item}
            </button>
          ))}
          <button
            type="button"
            className="ai-assistant__icon-button ai-assistant__clear-history"
            title="Очистить историю поиска"
            aria-label="Очистить историю поиска"
            onClick={handleClearHistory}
            disabled={loading}
          >
            ×
          </button>
        </div>
      )}

      {loading && <ProcessingIndicator label="Запрос обрабатывается..." />}
      {error && <div className="ai-assistant__error">{error}</div>}
      {!loading && !error && searched && results.length === 0 && (
        <div className="ai-assistant__empty">Ничего не найдено</div>
      )}
      {!loading && !error && diagnostics && (
        <SearchRetrievalDiagnostics diagnostics={diagnostics} resultCount={results.length} />
      )}
      <div className="ai-assistant__results">
        {results.map((r) => {
          const text = typeof r.text === 'string' ? r.text : '';
          const title = r.title || `Страница ${r.pageId}`;
          return (
            <article key={r.id} className="ai-assistant__result">
              {r.pageUrl ? (
                <a href={r.pageUrl} target="_blank" rel="noreferrer" className="ai-assistant__result-title">
                  {title}
                </a>
              ) : (
                <div className="ai-assistant__result-title">{title}</div>
              )}
              {text && <p className="ai-assistant__result-text">{text.slice(0, 300)}...</p>}
              {r.pageUrl && (
                <a
                  href={r.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ai-assistant__result-action"
                >
                  Открыть страницу
                </a>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
