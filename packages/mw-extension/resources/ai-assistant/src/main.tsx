import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { createAssistantEndpoint } from './assistantEndpoint';

const root = document.getElementById('ai-assistant-root');
if (root) {
  const gatewayUrl = root.dataset.gatewayUrl ?? '';
  const endpoint = createAssistantEndpoint({
    gatewayUrl,
    proxyEnabled: root.dataset.proxyEnabled === '1',
    proxyBase: root.dataset.proxyBase ?? '',
  });

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App gatewayUrl={gatewayUrl} endpoint={endpoint} />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
