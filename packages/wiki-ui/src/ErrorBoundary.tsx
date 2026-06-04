import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('WikiAI UI error:', error);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="app-main">
        <section className="page-panel">
          <h1>WikiAI</h1>
          <div className="callout callout-danger" role="alert">
            Ошибка интерфейса. Обновите страницу и повторите действие.
          </div>
        </section>
      </div>
    );
  }
}
