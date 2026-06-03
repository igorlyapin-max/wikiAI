import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

const root = document.getElementById('ai-assistant-root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App gatewayUrl={root.dataset.gatewayUrl ?? ''} />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
