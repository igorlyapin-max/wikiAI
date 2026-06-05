import { useState } from 'react';
import SearchTab from './components/SearchTab';
import ChatTab from './components/ChatTab';
import './assistant.css';

interface AppProps {
  gatewayUrl: string;
}

export default function App({ gatewayUrl }: AppProps) {
  const [tab, setTab] = useState<'search' | 'chat'>('search');
  const [chatMounted, setChatMounted] = useState(false);

  const openChat = (): void => {
    setChatMounted(true);
    setTab('chat');
  };

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
          id="ai-assistant-tab-search"
          type="button"
          role="tab"
          aria-selected={tab === 'search'}
          aria-controls="ai-assistant-panel-search"
          onClick={() => setTab('search')}
          className={tab === 'search' ? 'ai-assistant__tab ai-assistant__tab--active' : 'ai-assistant__tab'}
        >
          Поиск
        </button>
        <button
          id="ai-assistant-tab-chat"
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          aria-controls="ai-assistant-panel-chat"
          onClick={openChat}
          className={tab === 'chat' ? 'ai-assistant__tab ai-assistant__tab--active' : 'ai-assistant__tab'}
        >
          Чат
        </button>
      </div>
      <section
        id="ai-assistant-panel-search"
        className="ai-assistant__surface"
        role="tabpanel"
        aria-labelledby="ai-assistant-tab-search"
        hidden={tab !== 'search'}
      >
        <SearchTab gatewayUrl={gatewayUrl} />
      </section>
      <section
        id="ai-assistant-panel-chat"
        className="ai-assistant__surface"
        role="tabpanel"
        aria-labelledby="ai-assistant-tab-chat"
        hidden={tab !== 'chat'}
      >
        {chatMounted && <ChatTab gatewayUrl={gatewayUrl} />}
      </section>
    </div>
  );
}
