export interface RetrievalDiagnostics {
  originalMessage?: string;
  query?: string;
  retrievalQuery?: string;
  historyMessagesUsed?: number;
  requestedTopK?: number | null;
  retrievalTopK?: number;
  effectiveTopK?: number;
  contextTopK?: number;
  contextMaxChars?: number;
  retrievalQueryMode?: string;
  historyInjectedIntoRetrieval?: boolean;
  searchMode?: string;
  retrievalProfileId?: string | null;
  llmModel?: string;
  llmTemperature?: number;
  llmMaxTokens?: number;
  llmTimeoutMs?: number;
  showSources?: boolean;
  assistantUiMode?: string;
  rawChunks?: number;
  readableChunks?: number;
  trustedChunks?: number;
  finalResults?: number;
  retrievedSources?: number;
  finalSources?: number;
  contextSources?: number;
  contextSourceGroups?: number;
  citedSources?: number | null;
  displaySources?: number;
  duplicateContextChunksCollapsed?: number;
  sourceDisplayMode?: string;
  tailSourcesBelowThreshold?: number;
  colbertScores?: string;
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readColbertScores(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => {
      if (!isRecord(item)) return undefined;
      const id = readNumber(item.id);
      const score = readNumber(item.score);
      if (id === undefined || score === undefined) return undefined;
      return `${id}:${score.toFixed(3)}`;
    })
    .filter((item): item is string => Boolean(item));
  if (values.length === 0) return undefined;
  const visible = values.slice(0, 8).join(', ');
  return values.length > 8 ? `${visible}, ...` : visible;
}

export function normalizeRetrievalDiagnostics(value: unknown): RetrievalDiagnostics | undefined {
  if (!isRecord(value)) return undefined;

  const diagnostics: RetrievalDiagnostics = {
    originalMessage: readString(value.originalMessage),
    query: readString(value.query),
    retrievalQuery: readString(value.retrievalQuery),
    historyMessagesUsed: readNumber(value.historyMessagesUsed),
    requestedTopK: readOptionalNumber(value.requestedTopK),
    retrievalTopK: readNumber(value.retrievalTopK),
    effectiveTopK: readNumber(value.effectiveTopK),
    contextTopK: readNumber(value.contextTopK),
    contextMaxChars: readNumber(value.contextMaxChars),
    retrievalQueryMode: readString(value.retrievalQueryMode),
    historyInjectedIntoRetrieval: readBoolean(value.historyInjectedIntoRetrieval),
    searchMode: readString(value.searchMode),
    retrievalProfileId: readString(value.retrievalProfileId) ?? (value.retrievalProfileId === null ? null : undefined),
    llmModel: readString(value.llmModel),
    llmTemperature: readNumber(value.llmTemperature),
    llmMaxTokens: readNumber(value.llmMaxTokens),
    llmTimeoutMs: readNumber(value.llmTimeoutMs),
    showSources: readBoolean(value.showSources),
    assistantUiMode: readString(value.assistantUiMode),
    rawChunks: readNumber(value.rawChunks),
    readableChunks: readNumber(value.readableChunks),
    trustedChunks: readNumber(value.trustedChunks),
    finalResults: readNumber(value.finalResults),
    retrievedSources: readNumber(value.retrievedSources),
    finalSources: readNumber(value.finalSources),
    contextSources: readNumber(value.contextSources),
    contextSourceGroups: readNumber(value.contextSourceGroups),
    citedSources: readOptionalNumber(value.citedSources),
    displaySources: readNumber(value.displaySources),
    duplicateContextChunksCollapsed: readNumber(value.duplicateContextChunksCollapsed),
    sourceDisplayMode: readString(value.sourceDisplayMode),
    tailSourcesBelowThreshold: readNumber(value.tailSourcesBelowThreshold),
    colbertScores: readColbertScores(value.colbertScores),
  };

  return Object.values(diagnostics).some((item) => item !== undefined) ? diagnostics : undefined;
}

function formatValue(value: string | number | boolean | null | undefined): string {
  if (value === null) return 'не задано';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (value === undefined || value === '') return '-';
  return String(value);
}

function DiagnosticsGrid({ diagnostics }: { diagnostics: RetrievalDiagnostics }) {
  const rows: Array<[string, string | number | boolean | null | undefined]> = [
    ['Запрос', diagnostics.retrievalQuery ?? diagnostics.query],
    ['Исходное сообщение', diagnostics.originalMessage],
    ['Профиль', diagnostics.retrievalProfileId],
    ['LLM model', diagnostics.llmModel],
    ['llmTemperature', diagnostics.llmTemperature],
    ['llmMaxTokens', diagnostics.llmMaxTokens],
    ['llmTimeoutMs', diagnostics.llmTimeoutMs],
    ['showSources', diagnostics.showSources],
    ['assistantUiMode', diagnostics.assistantUiMode],
    ['retrievalQueryMode', diagnostics.retrievalQueryMode],
    ['historyInjectedIntoRetrieval', diagnostics.historyInjectedIntoRetrieval],
    ['requestedTopK', diagnostics.requestedTopK],
    ['retrievalTopK', diagnostics.retrievalTopK],
    ['effectiveTopK', diagnostics.effectiveTopK],
    ['contextTopK', diagnostics.contextTopK],
    ['contextMaxChars', diagnostics.contextMaxChars],
    ['raw/readable/trusted', [
      diagnostics.rawChunks,
      diagnostics.readableChunks,
      diagnostics.trustedChunks,
    ].map(formatValue).join(' / ')],
    ['finalResults', diagnostics.finalResults],
    ['retrievedSources', diagnostics.retrievedSources],
    ['finalSources', diagnostics.finalSources],
    ['contextSources', diagnostics.contextSources],
    ['contextSourceGroups', diagnostics.contextSourceGroups],
    ['citedSources', diagnostics.citedSources],
    ['displaySources', diagnostics.displaySources],
    ['duplicateContextChunksCollapsed', diagnostics.duplicateContextChunksCollapsed],
    ['sourceDisplayMode', diagnostics.sourceDisplayMode],
    ['tailSourcesBelowThreshold', diagnostics.tailSourcesBelowThreshold],
    ['ColBERT scores', diagnostics.colbertScores],
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
  const historyInjected = diagnostics.historyInjectedIntoRetrieval === true;
  const outputTopK = diagnostics.effectiveTopK ?? '-';
  const contextCount = diagnostics.contextSources ?? diagnostics.contextTopK ?? '-';
  const historySuffix = usedHistory && historyInjected ? ` и истории диалога (${historyCount})` : '';
  const promptHistoryNote = usedHistory && !historyInjected
    ? ` История учтена в ответе (${historyCount}), но не в поисковом запросе.`
    : '';

  return (
    <div className="ai-assistant__retrieval">
      <div className="ai-assistant__retrieval-note">
        Источники подобраны по текущему сообщению{historySuffix}.{promptHistoryNote}
      </div>
      <details className="ai-assistant__diagnostics">
        <summary>
          Retrieval: режим {diagnostics.searchMode ?? 'unknown'}, выдача {outputTopK}, контекст {contextCount}
        </summary>
        <DiagnosticsGrid diagnostics={diagnostics} />
      </details>
    </div>
  );
}
