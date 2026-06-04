import { useEffect, useState } from 'react';
import AssistantApp from '@wikiai/mw-assistant/App';
import AdminPage from './AdminPage';
import { routeFromPathname, routeHref, type WikiUiRoute } from './route';

interface AppProps {
  apiBase?: string;
  initialRoute?: WikiUiRoute;
}

export default function App({ apiBase = '', initialRoute }: AppProps) {
  const [route, setRoute] = useState<WikiUiRoute>(() => initialRoute ?? routeFromPathname(window.location.pathname));

  useEffect(() => {
    if (initialRoute) return undefined;
    const handlePopState = () => setRoute(routeFromPathname(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [initialRoute]);

  const navigate = (nextRoute: WikiUiRoute): void => {
    setRoute(nextRoute);
    if (!initialRoute) {
      window.history.pushState({}, '', routeHref(nextRoute));
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/ai/assistant" onClick={(event) => {
          event.preventDefault();
          navigate('assistant');
        }}>
          WikiAI
        </a>
        <nav className="top-nav" aria-label="WikiAI">
          <button
            type="button"
            className={route === 'assistant' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('assistant')}
          >
            Ассистент
          </button>
          <button
            type="button"
            className={route === 'admin' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('admin')}
          >
            Админ
          </button>
        </nav>
      </header>
      <main className="app-main">
        {route === 'admin' ? <AdminPage apiBase={apiBase} /> : <AssistantApp gatewayUrl={apiBase} />}
      </main>
    </div>
  );
}
