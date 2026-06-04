import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary';

function BrokenChild(): JSX.Element {
  throw new Error('Broken test child');
}

function suppressExpectedError(event: ErrorEvent): void {
  if (event.error instanceof Error && event.error.message === 'Broken test child') {
    event.preventDefault();
  }
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.addEventListener('error', suppressExpectedError);
  });

  afterEach(() => {
    window.removeEventListener('error', suppressExpectedError);
    vi.restoreAllMocks();
  });

  it('renders a WikiAI error state', () => {
    render(
      <ErrorBoundary>
        <BrokenChild />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading', { name: 'WikiAI' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Ошибка интерфейса.');
  });
});
