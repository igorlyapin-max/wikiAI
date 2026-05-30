import { useState, useRef, useEffect } from 'react';

interface ChatTabProps {
  gatewayUrl: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{ title: string; pageId: number }>;
}

export default function ChatTab({ gatewayUrl }: ChatTabProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);
    setLoading(true);

    try {
      const res = await fetch(`${gatewayUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message: userMsg }),
      });

      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      let sources: Array<{ title: string; pageId: number }> = [];

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
            if (data.type === 'token' && data.content) {
              assistantText += data.content;
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last && last.role === 'assistant') last.content = assistantText;
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
        return copy;
      });
    } catch (err) {
      console.error('Chat error:', err);
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Ошибка при генерации ответа.' }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 500 }}>
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
              }}
            >
              {m.content}
            </div>
            {m.sources && m.sources.length > 0 && (
              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                Источники: {m.sources.map((s) => s.title).join(', ')}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Введите сообщение..."
          disabled={loading}
          style={{ flex: 1, padding: 8, fontSize: 16 }}
        />
        <button onClick={handleSend} disabled={loading} style={{ padding: '8px 16px' }}>
          {loading ? '...' : 'Отправить'}
        </button>
      </div>
    </div>
  );
}
