import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary';

function BrokenComponent(): JSX.Element {
  throw new Error('broken');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('показывает fallback при ошибке дочернего UI', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const preventExpectedError = (event: ErrorEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('error', preventExpectedError);

    try {
      render(
        <ErrorBoundary>
          <BrokenComponent />
        </ErrorBoundary>
      );
    } finally {
      window.removeEventListener('error', preventExpectedError);
    }

    expect(screen.getByText('AI-помощник')).toBeInTheDocument();
    expect(screen.getByText('Ошибка интерфейса AI-помощника. Обновите страницу и повторите действие.')).toBeInTheDocument();
  });
});
