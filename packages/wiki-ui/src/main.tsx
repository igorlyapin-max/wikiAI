import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './ErrorBoundary';
import './styles.css';

const root = document.getElementById('wikiai-ui-root');

if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App apiBase={root.dataset.apiBase ?? root.dataset.gatewayUrl ?? ''} />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
