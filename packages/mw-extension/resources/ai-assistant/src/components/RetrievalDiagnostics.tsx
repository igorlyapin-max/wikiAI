export interface RetrievalDiagnostics {
  originalMessage?: string;
  query?: string;
  retrievalQuery?: string;
  historyMessagesUsed?: number;
  requestedTopK?: number | null;
  effectiveTopK?: number;
  searchMode?: string;
  retrievalProfileId?: string | null;
  rawChunks?: number;
  readableChunks?: number;
  trustedChunks?: number;
  finalResults?: number;
  finalSources?: number;
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

function readOptionalNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return readNumber(value);
}

export function normalizeRetrievalDiagnostics(value: unknown): RetrievalDiagnostics | undefined {
  if (!isRecord(value)) return undefined;

  const diagnostics: RetrievalDiagnostics = {
    originalMessage: readString(value.originalMessage),
    query: readString(value.query),
    retrievalQuery: readString(value.retrievalQuery),
    historyMessagesUsed: readNumber(value.historyMessagesUsed),
    requestedTopK: readOptionalNumber(value.requestedTopK),
    effectiveTopK: readNumber(value.effectiveTopK),
    searchMode: readString(value.searchMode),
    retrievalProfileId: readString(value.retrievalProfileId) ?? (value.retrievalProfileId === null ? null : undefined),
    rawChunks: readNumber(value.rawChunks),
    readableChunks: readNumber(value.readableChunks),
    trustedChunks: readNumber(value.trustedChunks),
    finalResults: readNumber(value.finalResults),
    finalSources: readNumber(value.finalSources),
  };

  return Object.values(diagnostics).some((item) => item !== undefined) ? diagnostics : undefined;
}

function formatValue(value: string | number | null | undefined): string {
  if (value === null) return 'не задано';
  if (value === undefined || value === '') return '-';
  return String(value);
}

function DiagnosticsGrid({ diagnostics }: { diagnostics: RetrievalDiagnostics }) {
  const rows: Array<[string, string | number | null | undefined]> = [
    ['Запрос', diagnostics.retrievalQuery ?? diagnostics.query],
    ['Исходное сообщение', diagnostics.originalMessage],
    ['Профиль', diagnostics.retrievalProfileId],
    ['requestedTopK', diagnostics.requestedTopK],
    ['effectiveTopK', diagnostics.effectiveTopK],
    ['raw/readable/trusted', [
      diagnostics.rawChunks,
      diagnostics.readableChunks,
      diagnostics.trustedChunks,
    ].map(formatValue).join(' / ')],
    ['finalResults', diagnostics.finalResults],
    ['finalSources', diagnostics.finalSources],
  ];
  const visibleRows = rows.filter(([, value]) => value !== undefined);

  return (
    <dl className="ai-assistant__diagnostics-grid">
      {visibleRows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SearchRetrievalDiagnostics({
  diagnostics,
  resultCount,
}: {
  diagnostics: RetrievalDiagnostics;
  resultCount: number;
}) {
  const count = diagnostics.finalResults ?? resultCount;
  const mode = diagnostics.searchMode ?? 'unknown';
  const topK = diagnostics.effectiveTopK ?? '-';

  return (
    <details className="ai-assistant__diagnostics">
      <summary>Найдено {count}, режим {mode}, topK {topK}</summary>
      <DiagnosticsGrid diagnostics={diagnostics} />
    </details>
  );
}

export function ChatRetrievalDiagnostics({ diagnostics }: { diagnostics: RetrievalDiagnostics }) {
  const historyCount = diagnostics.historyMessagesUsed ?? 0;
  const usedHistory = historyCount > 0;

  return (
    <div className="ai-assistant__retrieval">
      <div className="ai-assistant__retrieval-note">
        Источники подобраны по текущему сообщению{usedHistory ? ` и истории диалога (${historyCount})` : ''}.
      </div>
      <details className="ai-assistant__diagnostics">
        <summary>
          Retrieval: режим {diagnostics.searchMode ?? 'unknown'}, topK {diagnostics.effectiveTopK ?? '-'}
        </summary>
        <DiagnosticsGrid diagnostics={diagnostics} />
      </details>
    </div>
  );
}
