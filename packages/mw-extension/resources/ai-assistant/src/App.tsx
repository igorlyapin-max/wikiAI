import { useState } from 'react';
import SearchTab from './components/SearchTab';
import ChatTab from './components/ChatTab';
import './assistant.css';

interface AppProps {
  gatewayUrl: string;
}

export default function App({ gatewayUrl }: AppProps) {
  const [tab, setTab] = useState<'search' | 'chat'>('search');

  return (
    <div className="ai-assistant">
      <header className="ai-assistant__header">
        <div>
          <h1>AI-помощник</h1>
          <p>Поиск по базе знаний и диалоги с источниками</p>
        </div>
      </header>
      <div className="ai-assistant__tabs" role="tablist" aria-label="AI-помощник">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'search'}
          onClick={() => setTab('search')}
          className={tab === 'search' ? 'ai-assistant__tab ai-assistant__tab--active' : 'ai-assistant__tab'}
        >
          Поиск
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          onClick={() => setTab('chat')}
          className={tab === 'chat' ? 'ai-assistant__tab ai-assistant__tab--active' : 'ai-assistant__tab'}
        >
          Чат
        </button>
      </div>
      <section className="ai-assistant__surface">
        {tab === 'search' ? <SearchTab gatewayUrl={gatewayUrl} /> : <ChatTab gatewayUrl={gatewayUrl} />}
      </section>
    </div>
  );
}
