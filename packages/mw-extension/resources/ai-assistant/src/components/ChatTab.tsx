import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChatRetrievalDiagnostics,
  normalizeRetrievalDiagnostics,
  type RetrievalDiagnostics,
} from './RetrievalDiagnostics';

interface ChatTabProps {
  gatewayUrl: string;
}

interface ConflictSource {
  title: string;
  claim?: string;
  trustScore?: number;
  status?: string;
}

interface ConflictDetectionResult {
  hasConflict: boolean;
  lowTrust: boolean;
  confidence: number;
  summary?: string;
  conflictingSources: ConflictSource[];
  recommendedSourceTitle?: string;
  lowTrustReason?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: MessageSource[];
  conflict?: ConflictDetectionResult;
  retrievalDiagnostics?: RetrievalDiagnostics;
}

interface MessageSource {
  citationIndex?: number;
  title: string;
  displayTitle?: string;
  pageId: number;
  pageUrl?: string;
  sourceType?: string;
  attachmentFilename?: string;
  attachmentMime?: string;
  attachmentProcessingMode?: string;
  parentPageTitle?: string;
  parentPageUrl?: string;
  attachmentUrl?: string;
}

interface ChatSessionSummary {
  id: string;
  conversationId: string;
  title: string;
  status: 'active' | 'archived' | 'deleted';
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
}

interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: MessageSource[];
  createdAt: string;
}

type SessionFilter = 'active' | 'archived';
type AssistantUiMode = 'compact' | 'standard' | 'expert';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readAssistantUiMode(value: unknown): AssistantUiMode {
  return value === 'compact' || value === 'expert' ? value : 'standard';
}

function normalizeAssistantUiModeConfig(value: unknown): AssistantUiMode {
  const values = isRecord(value) && isRecord(value.values) ? value.values : value;
  return isRecord(values) ? readAssistantUiMode(values.assistantUiMode) : 'standard';
}

function readSource(value: unknown): MessageSource | undefined {
  if (!isRecord(value)) return undefined;
  const title = readString(value.title);
  if (!title) return undefined;
  return {
    citationIndex: readNumber(value.citationIndex),
    title,
    displayTitle: readString(value.displayTitle),
    pageId: readNumber(value.pageId) ?? 0,
    pageUrl: readString(value.pageUrl),
    sourceType: readString(value.sourceType),
    attachmentFilename: readString(value.attachmentFilename),
    attachmentMime: readString(value.attachmentMime),
    attachmentProcessingMode: readString(value.attachmentProcessingMode),
    parentPageTitle: readString(value.parentPageTitle),
    parentPageUrl: readString(value.parentPageUrl),
    attachmentUrl: readString(value.attachmentUrl),
  };
}

function readSources(value: unknown): MessageSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources = value.map(readSource).filter((item): item is MessageSource => Boolean(item));
  return sources.length > 0 ? sources : undefined;
}

function normalizeSession(value: unknown): ChatSessionSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const conversationId = readString(value.conversationId);
  const status = value.status;
  if (!id || !conversationId || (status !== 'active' && status !== 'archived' && status !== 'deleted')) {
    return undefined;
  }
  return {
    id,
    conversationId,
    title: readString(value.title) ?? conversationId,
    status,
    messageCount: readNumber(value.messageCount) ?? 0,
    createdAt: readString(value.createdAt) ?? '',
    updatedAt: readString(value.updatedAt) ?? '',
    lastMessageAt: readString(value.lastMessageAt),
  };
}

function normalizeSessions(value: unknown): ChatSessionSummary[] {
  return Array.isArray(value)
    ? value.map(normalizeSession).filter((item): item is ChatSessionSummary => Boolean(item))
    : [];
}

function normalizeStoredMessage(value: unknown): StoredChatMessage | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const role = value.role;
  const content = readString(value.content);
  if (!id || (role !== 'user' && role !== 'assistant') || !content) return undefined;
  return {
    id,
    role,
    content,
    sources: readSources(value.sources),
    createdAt: readString(value.createdAt) ?? '',
  };
}

function normalizeStoredMessages(value: unknown): StoredChatMessage[] {
  return Array.isArray(value)
    ? value.map(normalizeStoredMessage).filter((item): item is StoredChatMessage => Boolean(item))
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

function formatOptionalScore(value: unknown, digits: number): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : undefined;
}

function formatDate(value: string | undefined): string {
  if (!value) return '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('ru-RU') : value;
}

function getConflictWarningTitle(conflict: ConflictDetectionResult): string {
  if (conflict.hasConflict && conflict.lowTrust) {
    return 'Найдены противоречия и снижена надежность источников';
  }
  if (conflict.hasConflict) {
    return 'Найдены возможные противоречия в источниках';
  }
  return 'Надежность источников требует проверки';
}

function ProcessingIndicator({ label }: { label: string }) {
  return (
    <div className="ai-assistant__status" role="status" aria-live="polite">
      <span aria-hidden="true" className="ai-assistant__spinner" />
      <span>{label}</span>
    </div>
  );
}

function sourceHref(source: MessageSource): string | undefined {
  return source.parentPageUrl ?? source.pageUrl;
}

function sourceLabel(source: MessageSource): string {
  return source.attachmentFilename ?? source.displayTitle ?? source.title;
}

function renderSourceListItem(source: MessageSource): ReactNode {
  const label = sourceLabel(source);
  if (source.attachmentFilename) {
    const parentTitle = source.parentPageTitle ?? source.title;
    const parentUrl = source.parentPageUrl ?? source.pageUrl;
    return (
      <>
        {label}
        {parentTitle && (
          <>
            {' — страница: '}
            {parentUrl ? (
              <a href={parentUrl} target="_blank" rel="noreferrer" className="ai-assistant__source-link">
                {parentTitle}
              </a>
            ) : (
              parentTitle
            )}
          </>
        )}
        {source.attachmentUrl && (
          <>
            {' — '}
            <a href={source.attachmentUrl} target="_blank" rel="noreferrer" className="ai-assistant__source-link">
              файл
            </a>
          </>
        )}
      </>
    );
  }

  const href = sourceHref(source);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="ai-assistant__source-link">
      {label}
    </a>
  ) : label;
}

function stripTrailingGeneratedSourceList(content: string): string {
  const matches = Array.from(content.matchAll(/(?:^|\n)\s*Источники:\s*[\s\S]*$/giu));
  const match = matches[matches.length - 1];
  if (!match || match.index === undefined) return content;
  const suffix = content.slice(match.index);
  if (!/\[(?:источник\s+)?\d+\]/iu.test(suffix)) return content;
  return content.slice(0, match.index).trimEnd();
}

function renderAssistantContent(content: string, sources: MessageSource[] | undefined): ReactNode {
  const visibleContent = stripTrailingGeneratedSourceList(content);
  if (!sources || sources.length === 0) return visibleContent;

  const sourcesByCitationIndex = new Map<number, MessageSource>();
  sources.forEach((source, index) => {
    sourcesByCitationIndex.set(source.citationIndex ?? index + 1, source);
  });
  const parts: ReactNode[] = [];
  const citationPattern = /\[(?:источник\s+)?(\d+)\]/giu;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = citationPattern.exec(visibleContent)) !== null) {
    const [raw, rawNumber] = match;
    const citationNumber = Number(rawNumber);
    const source = Number.isInteger(citationNumber) ? sourcesByCitationIndex.get(citationNumber) : undefined;

    if (match.index > lastIndex) {
      parts.push(visibleContent.slice(lastIndex, match.index));
    }

    const href = source ? sourceHref(source) : undefined;
    if (source && href) {
      parts.push(
        <a
          key={`${match.index}-${raw}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="ai-assistant__citation"
          aria-label={`Открыть источник ${citationNumber}: ${sourceLabel(source)}`}
          title={sourceLabel(source)}
        >
          {raw}
        </a>
      );
    } else {
      parts.push(raw);
    }

    lastIndex = match.index + raw.length;
  }

  if (lastIndex < visibleContent.length) {
    parts.push(visibleContent.slice(lastIndex));
  }

  return parts.length > 0 ? parts : visibleContent;
}

export default function ChatTab({ gatewayUrl }: ChatTabProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('active');
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [activeSessionStatus, setActiveSessionStatus] = useState<ChatSessionSummary['status'] | undefined>();
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [historyError, setHistoryError] = useState<string | undefined>();
  const [assistantUiMode, setAssistantUiMode] = useState<AssistantUiMode>('standard');
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionLoadRequestRef = useRef(0);
  const archiveReadOnly = activeSessionStatus === 'archived';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;

    const loadUiConfig = async (): Promise<void> => {
      try {
        const res = await fetch(`${gatewayUrl}/api/ui/config`, { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setAssistantUiMode(normalizeAssistantUiModeConfig(data));
        }
      } catch {
        if (!cancelled) setAssistantUiMode('standard');
      }
    };

    void loadUiConfig();

    return () => {
      cancelled = true;
    };
  }, [gatewayUrl]);

  const loadSessions = async (filter = sessionFilter): Promise<ChatSessionSummary[]> => {
    const requestId = sessionLoadRequestRef.current + 1;
    sessionLoadRequestRef.current = requestId;
    setSessionsLoading(true);
    setHistoryError(undefined);
    try {
      const res = await fetch(`${gatewayUrl}/api/chat/sessions?status=${encodeURIComponent(filter)}&limit=20`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readGatewayError(res));
      const data = await res.json();
      const values = normalizeSessions(isRecord(data) ? data.values : undefined);
      if (sessionLoadRequestRef.current === requestId) {
        setSessions(values);
      }
      return values;
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Ошибка загрузки истории чатов.';
      if (sessionLoadRequestRef.current === requestId) {
        setHistoryError(message);
        setSessions([]);
      }
      return [];
    } finally {
      if (sessionLoadRequestRef.current === requestId) {
        setSessionsLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadSessions(sessionFilter);
  }, [gatewayUrl, sessionFilter]);

  const handleNewChat = () => {
    if (sessionFilter !== 'active') {
      setSessionFilter('active');
    }
    setActiveSessionId(undefined);
    setActiveSessionStatus(undefined);
    setConversationId(undefined);
    setMessages([]);
    setHistoryError(undefined);
  };

  const handleSessionFilterChange = (filter: SessionFilter) => {
    setSessionFilter(filter);
    setActiveSessionId(undefined);
    setActiveSessionStatus(undefined);
    setConversationId(undefined);
    setMessages([]);
    setHistoryError(undefined);
  };

  const handleSelectSession = async (session: ChatSessionSummary) => {
    setActiveSessionId(session.id);
    setActiveSessionStatus(session.status);
    setConversationId(session.status === 'active' ? session.conversationId : undefined);
    setHistoryError(undefined);
    try {
      const res = await fetch(`${gatewayUrl}/api/chat/sessions/${encodeURIComponent(session.id)}/messages`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readGatewayError(res));
      const data = await res.json();
      const stored = normalizeStoredMessages(isRecord(data) ? data.values : undefined);
      setMessages(stored.map((item) => ({
        role: item.role,
        content: item.content,
        sources: item.sources,
      })));
    } catch (err) {
      setMessages([]);
      setHistoryError(err instanceof Error && err.message ? err.message : 'Ошибка загрузки сообщений чата.');
    }
  };

  const handleExportArchive = async () => {
    try {
      const res = await fetch(`${gatewayUrl}/api/chat/archive/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ format: 'json' }),
      });
      if (!res.ok) throw new Error(await readGatewayError(res));
      const data = await res.json();
      const values = isRecord(data) && isRecord(data.values) ? data.values : {};
      const content = typeof values.content === 'string' ? values.content : JSON.stringify(values, null, 2);
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'chat-archive.json';
      link.click();
      URL.revokeObjectURL(url);
      await loadSessions(sessionFilter);
    } catch (err) {
      setHistoryError(err instanceof Error && err.message ? err.message : 'Ошибка экспорта архива.');
    }
  };

  const handleSend = async () => {
    if (!input.trim() || loading || archiveReadOnly) return;
    const userMsg = input.trim();
    let currentConversationId = conversationId;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);
    setLoading(true);
    setHistoryError(undefined);

    try {
      const res = await fetch(`${gatewayUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: userMsg,
          ...(currentConversationId ? { conversationId: currentConversationId } : {}),
        }),
      });

      if (!res.ok) {
        throw new Error(await readGatewayError(res));
      }

      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      let sources: MessageSource[] = [];
      let conflict: ConflictDetectionResult | undefined;
      let retrievalDiagnostics: RetrievalDiagnostics | undefined;

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') continue;

          try {
            const data = JSON.parse(jsonStr);
            if (data.type === 'conversation' && typeof data.conversationId === 'string') {
              currentConversationId = data.conversationId;
              setConversationId(data.conversationId);
            } else if (data.type === 'token' && data.content) {
              assistantText += data.content;
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last && last.role === 'assistant') last.content = assistantText;
                return copy;
              });
            } else if (data.type === 'message' && typeof data.content === 'string') {
              assistantText = data.content;
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last && last.role === 'assistant') last.content = assistantText;
                return copy;
              });
            } else if (data.type === 'conflict') {
              conflict = data.conflict;
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last && last.role === 'assistant') last.conflict = conflict;
                return copy;
              });
            } else if (data.type === 'diagnostics') {
              retrievalDiagnostics = normalizeRetrievalDiagnostics(data.diagnostics);
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last && last.role === 'assistant') last.retrievalDiagnostics = retrievalDiagnostics;
                return copy;
              });
            } else if (data.type === 'ui') {
              setAssistantUiMode(readAssistantUiMode(data.assistantUiMode));
            } else if (data.type === 'sources') {
              sources = data.sources || [];
            }
          } catch {
            // ignore malformed
          }
        }
      }

      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') last.sources = sources;
        if (last && last.role === 'assistant') last.conflict = conflict;
        if (last && last.role === 'assistant') last.retrievalDiagnostics = retrievalDiagnostics;
        return copy;
      });
      if (sessionFilter !== 'active') {
        setSessionFilter('active');
      }
      const loaded = await loadSessions('active');
      const active = loaded.find((session) => session.conversationId === currentConversationId);
      setActiveSessionId(active?.id);
      setActiveSessionStatus(active?.status);
    } catch (err) {
      console.error('Chat error:', err);
      const content = err instanceof Error && err.message ? err.message : 'Ошибка при генерации ответа.';
      setMessages((prev) => [...prev, { role: 'assistant', content }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`ai-assistant__chat ai-assistant__chat--${assistantUiMode}`}>
      <aside className="ai-assistant__sidebar">
        <div className="ai-assistant__toolbar" aria-label="Управление чатами">
          <button
            type="button"
            onClick={handleNewChat}
            className="ai-assistant__icon-button ai-assistant__icon-button--primary"
            title="Новый чат"
            aria-label="Новый чат"
          >
            ＋
          </button>
          <button
            type="button"
            onClick={() => handleSessionFilterChange('active')}
            className={sessionFilter === 'active'
              ? 'ai-assistant__icon-button ai-assistant__icon-button--active'
              : 'ai-assistant__icon-button'}
            title="Актив"
            aria-label="Актив"
          >
            ●
          </button>
          <button
            type="button"
            onClick={() => handleSessionFilterChange('archived')}
            className={sessionFilter === 'archived'
              ? 'ai-assistant__icon-button ai-assistant__icon-button--active'
              : 'ai-assistant__icon-button'}
            title="Архив"
            aria-label="Архив"
          >
            ◷
          </button>
          {sessionFilter === 'archived' && (
            <button
              type="button"
              onClick={handleExportArchive}
              disabled={sessionsLoading}
              className="ai-assistant__icon-button"
              title="Выгрузить архив"
              aria-label="Выгрузить архив"
            >
              ⇩
            </button>
          )}
        </div>
        {historyError && <div className="ai-assistant__error">{historyError}</div>}
        {sessionsLoading && <div className="ai-assistant__empty">Загрузка...</div>}
        {!sessionsLoading && sessions.length === 0 && (
          <div className="ai-assistant__empty">Чатов нет</div>
        )}
        <div className="ai-assistant__session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={activeSessionId === session.id
                ? 'ai-assistant__session-card ai-assistant__session-card--active'
                : 'ai-assistant__session-card'}
            >
              <button
                type="button"
                onClick={() => handleSelectSession(session)}
                className="ai-assistant__session-button"
                title={session.title}
              >
                <div className="ai-assistant__session-title">{session.title}</div>
                <div className="ai-assistant__session-meta">{session.messageCount} сообщений</div>
                <div className="ai-assistant__session-meta">{formatDate(session.lastMessageAt || session.createdAt)}</div>
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="ai-assistant__conversation" aria-label="Диалог">
        <div className="ai-assistant__messages">
          {messages.map((m, i) => (
            <div
              key={i}
              className={m.role === 'user'
                ? 'ai-assistant__message ai-assistant__message--user'
                : 'ai-assistant__message ai-assistant__message--assistant'}
            >
              <div className="ai-assistant__bubble">
                {m.role === 'assistant' ? renderAssistantContent(m.content, m.sources) : m.content}
              </div>
              {m.conflict && (
                <div className="ai-assistant__conflict">
                  <div className="ai-assistant__conflict-title">
                    {getConflictWarningTitle(m.conflict)}
                  </div>
                  {m.conflict.summary && <div>{m.conflict.summary}</div>}
                  <div>
                    Уверенность детектора: {Math.round((m.conflict.confidence || 0) * 100)}%
                  </div>
                  {m.conflict.hasConflict && m.conflict.recommendedSourceTitle && (
                    <div>Приоритетный источник: {m.conflict.recommendedSourceTitle}</div>
                  )}
                  {m.conflict.lowTrustReason && <div>{m.conflict.lowTrustReason}</div>}
                  {m.conflict.conflictingSources.length > 0 && (
                    <ul>
                      {m.conflict.conflictingSources.map((source, sourceIndex) => {
                        const trustScore = formatOptionalScore(source.trustScore, 2);
                        return (
                          <li key={`${source.title}-${sourceIndex}`}>
                            <strong>{source.title}</strong>
                            {trustScore ? `, trust ${trustScore}` : ''}
                            {source.claim ? `: ${source.claim}` : ''}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
              {m.sources && m.sources.length > 0 && (
                <div className="ai-assistant__sources">
                  Источники:{' '}
                  {m.sources.map((s, sourceIndex) => (
                    <span key={`${s.pageId}-${s.title}-${sourceIndex}`}>
                      {sourceIndex > 0 ? ', ' : ''}
                      [{s.citationIndex ?? sourceIndex + 1}]{' '}
                      {renderSourceListItem(s)}
                    </span>
                  ))}
                </div>
              )}
              {m.role === 'assistant' && m.retrievalDiagnostics && (
                <ChatRetrievalDiagnostics diagnostics={m.retrievalDiagnostics} />
              )}
            </div>
          ))}
          {loading && <ProcessingIndicator label="Запрос обрабатывается..." />}
          <div ref={bottomRef} />
        </div>
        <div className="ai-assistant__composer">
          <input
            className="ai-assistant__input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSend();
            }}
            placeholder={archiveReadOnly ? 'Архивный чат доступен только для чтения' : 'Введите сообщение...'}
            disabled={loading || archiveReadOnly}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={loading || archiveReadOnly}
            className="ai-assistant__icon-button ai-assistant__icon-button--primary"
            title={loading ? 'Запрос обрабатывается' : 'Отправить'}
            aria-label="Отправить"
          >
            {loading ? '…' : '➤'}
          </button>
        </div>
      </section>
    </div>
  );
}
