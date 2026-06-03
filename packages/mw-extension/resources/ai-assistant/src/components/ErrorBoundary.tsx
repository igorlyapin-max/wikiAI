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
    console.error('AI assistant UI error:', error);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: 16 }}>
        <h1>AI-помощник</h1>
        <div style={{ padding: 12, border: '1px solid #DC2626', color: '#DC2626', borderRadius: 4 }}>
          Ошибка интерфейса AI-помощника. Обновите страницу и повторите действие.
        </div>
      </div>
    );
  }
}
