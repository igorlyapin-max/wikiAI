import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('переключает вкладки поиска и чата', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ values: [] })));
    vi.stubGlobal('fetch', fetchMock);

    render(<App gatewayUrl="https://gateway.example" />);

    expect(screen.getByPlaceholderText('Введите вопрос...')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Чат' }));

    expect(await screen.findByPlaceholderText('Введите сообщение...')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/api/chat/sessions?status=active&limit=20',
      { credentials: 'include' }
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Поиск' }));

    expect(screen.getByPlaceholderText('Введите вопрос...')).toBeInTheDocument();
  });
});
