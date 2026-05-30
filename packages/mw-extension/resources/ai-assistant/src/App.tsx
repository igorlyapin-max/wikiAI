import { useState } from 'react';
import SearchTab from './components/SearchTab';
import ChatTab from './components/ChatTab';

interface AppProps {
  gatewayUrl: string;
}

export default function App({ gatewayUrl }: AppProps) {
  const [tab, setTab] = useState<'search' | 'chat'>('search');

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 16 }}>
      <h1>AI-помощник</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setTab('search')}
          style={{
            padding: '8px 16px',
            background: tab === 'search' ? '#4a90d9' : '#f0f0f0',
            color: tab === 'search' ? '#fff' : '#333',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Поиск
        </button>
        <button
          onClick={() => setTab('chat')}
          style={{
            padding: '8px 16px',
            background: tab === 'chat' ? '#4a90d9' : '#f0f0f0',
            color: tab === 'chat' ? '#fff' : '#333',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Чат
        </button>
      </div>
      {tab === 'search' ? <SearchTab gatewayUrl={gatewayUrl} /> : <ChatTab gatewayUrl={gatewayUrl} />}
    </div>
  );
}
