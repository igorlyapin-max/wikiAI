import { useState } from 'react';

interface SearchTabProps {
  gatewayUrl: string;
}

interface SearchResult {
  id: string;
  pageId: number;
  title: string;
  text: string;
  score: number;
}

export default function SearchTab({ gatewayUrl }: SearchTabProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${gatewayUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ query, topK: 5 }),
      });
      const data = await res.json();
      setResults(data.results || []);
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
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
          {loading ? '...' : 'Найти'}
        </button>
      </div>
      <div style={{ marginTop: 16 }}>
        {results.map((r) => (
          <div key={r.id} style={{ marginBottom: 12, padding: 12, border: '1px solid #ddd', borderRadius: 4 }}>
            <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{r.title}</div>
            <div style={{ color: '#555', fontSize: 14 }}>{r.text.slice(0, 300)}...</div>
            <div style={{ marginTop: 4, fontSize: 12, color: '#888' }}>Score: {r.score.toFixed(3)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
