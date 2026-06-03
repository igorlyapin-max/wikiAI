import { useEffect, useRef, useState } from 'react';

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
  sources?: Array<{ title: string; pageId: number; pageUrl?: string }>;
  conflict?: ConflictDetectionResult;
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
  sources?: Array<{ title: string; pageId: number; pageUrl?: string }>;
  createdAt: string;
}

type SessionFilter = 'active' | 'archived';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readSource(value: unknown): { title: string; pageId: number; pageUrl?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const title = readString(value.title);
  if (!title) return undefined;
  return {
    title,
    pageId: readNumber(value.pageId) ?? 0,
    pageUrl: readString(value.pageUrl),
  };
}

function readSources(value: unknown): Array<{ title: string; pageId: number; pageUrl?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources = value.map(readSource).filter((item): item is { title: string; pageId: number; pageUrl?: string } => Boolean(item));
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
        marginTop: 4,
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const archiveReadOnly = activeSessionStatus === 'archived';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadSessions = async (filter = sessionFilter): Promise<ChatSessionSummary[]> => {
    setSessionsLoading(true);
    setHistoryError(undefined);
    try {
      const res = await fetch(`${gatewayUrl}/api/chat/sessions?status=${encodeURIComponent(filter)}&limit=20`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readGatewayError(res));
      const data = await res.json();
      const values = normalizeSessions(isRecord(data) ? data.values : undefined);
      setSessions(values);
      return values;
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Ошибка загрузки истории чатов.';
      setHistoryError(message);
      setSessions([]);
      return [];
    } finally {
      setSessionsLoading(false);
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
      let sources: Array<{ title: string; pageId: number; pageUrl?: string }> = [];
      let conflict: ConflictDetectionResult | undefined;

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
            } else if (data.type === 'conflict') {
              conflict = data.conflict;
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last && last.role === 'assistant') last.conflict = conflict;
                return copy;
              });
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
    <>
    <style>{SPINNER_KEYFRAMES}</style>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, minHeight: 560 }}>
      <aside style={{ flex: '0 1 220px', border: '1px solid #ddd', borderRadius: 4, padding: 10, overflowY: 'auto', maxHeight: 560 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button type="button" onClick={handleNewChat} style={{ padding: '6px 10px', flex: 1 }}>
            Новый чат
          </button>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => handleSessionFilterChange('active')}
            style={{ padding: '5px 8px', flex: 1, background: sessionFilter === 'active' ? '#111827' : '#f0f0f0', color: sessionFilter === 'active' ? '#fff' : '#333' }}
          >
            Актив
          </button>
          <button
            type="button"
            onClick={() => handleSessionFilterChange('archived')}
            style={{ padding: '5px 8px', flex: 1, background: sessionFilter === 'archived' ? '#111827' : '#f0f0f0', color: sessionFilter === 'archived' ? '#fff' : '#333' }}
          >
            Архив
          </button>
        </div>
        {sessionFilter === 'archived' && (
          <button
            type="button"
            onClick={handleExportArchive}
            disabled={sessionsLoading}
            style={{ padding: '6px 10px', width: '100%', marginBottom: 8 }}
          >
            Выгрузить архив
          </button>
        )}
        {historyError && <div style={{ color: '#DC2626', fontSize: 12, marginBottom: 8 }}>{historyError}</div>}
        {sessionsLoading && <div style={{ color: '#666', fontSize: 12 }}>Загрузка...</div>}
        {!sessionsLoading && sessions.length === 0 && (
          <div style={{ color: '#666', fontSize: 12 }}>Чатов нет</div>
        )}
        {sessions.map((session) => (
          <div
            key={session.id}
            style={{
              border: activeSessionId === session.id ? '1px solid #111827' : '1px solid #ddd',
              borderRadius: 4,
              padding: 8,
              marginBottom: 8,
              background: activeSessionId === session.id ? '#f9fafb' : '#fff',
            }}
          >
            <button
              type="button"
              onClick={() => handleSelectSession(session)}
              style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}
              title={session.title}
            >
              <div style={{ fontWeight: 700, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.title}</div>
              <div style={{ color: '#666', fontSize: 12 }}>{session.messageCount} сообщений</div>
              <div style={{ color: '#666', fontSize: 12 }}>{formatDate(session.lastMessageAt || session.createdAt)}</div>
            </button>
          </div>
        ))}
      </aside>

      <section style={{ display: 'flex', flex: '1 1 320px', flexDirection: 'column', minWidth: 0, height: 560 }}>
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 4, padding: 12 }}>
          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 12, textAlign: m.role === 'user' ? 'right' : 'left' }}>
              <div
                style={{
                  display: 'inline-block',
                  padding: '8px 12px',
                  borderRadius: 12,
                  background: m.role === 'user' ? '#4a90d9' : '#f0f0f0',
                  color: m.role === 'user' ? '#fff' : '#333',
                  maxWidth: '80%',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                {m.content}
              </div>
              {m.conflict && (
                <div
                  style={{
                    marginTop: 6,
                    display: 'inline-block',
                    maxWidth: '80%',
                    padding: '8px 10px',
                    border: '1px solid #d97706',
                    borderRadius: 4,
                    background: '#fff7ed',
                    color: '#7c2d12',
                    fontSize: 12,
                    textAlign: 'left',
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    {getConflictWarningTitle(m.conflict)}
                  </div>
                  {m.conflict.summary && <div>{m.conflict.summary}</div>}
                  <div style={{ marginTop: 4 }}>
                    Уверенность детектора: {Math.round((m.conflict.confidence || 0) * 100)}%
                  </div>
                  {m.conflict.hasConflict && m.conflict.recommendedSourceTitle && (
                    <div>Приоритетный источник: {m.conflict.recommendedSourceTitle}</div>
                  )}
                  {m.conflict.lowTrustReason && <div>{m.conflict.lowTrustReason}</div>}
                  {m.conflict.conflictingSources.length > 0 && (
                    <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
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
                <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                  Источники:{' '}
                  {m.sources.map((s, sourceIndex) => (
                    <span key={`${s.pageId}-${s.title}`}>
                      {sourceIndex > 0 ? ', ' : ''}
                      {s.pageUrl ? (
                        <a href={s.pageUrl} target="_blank" rel="noreferrer" style={{ color: '#4a90d9' }}>
                          {s.title}
                        </a>
                      ) : (
                        s.title
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {loading && <ProcessingIndicator label="Запрос обрабатывается..." />}
          <div ref={bottomRef} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={archiveReadOnly ? 'Архивный чат доступен только для чтения' : 'Введите сообщение...'}
            disabled={loading || archiveReadOnly}
            style={{ flex: 1, padding: 8, fontSize: 16, minWidth: 0 }}
          />
          <button onClick={handleSend} disabled={loading || archiveReadOnly} style={{ padding: '8px 16px' }}>
            {loading ? 'Обработка...' : 'Отправить'}
          </button>
        </div>
      </section>
    </div>
    </>
  );
}
