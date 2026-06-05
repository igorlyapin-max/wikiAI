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
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/chat/sessions')) {
        return Promise.resolve(jsonResponse({
          values: [
            {
              id: 's1',
              conversationId: 'c1',
              title: 'Первый чат',
              status: 'active',
              messageCount: 2,
              createdAt: '2026-06-03T10:00:00Z',
              updatedAt: '2026-06-03T10:01:00Z',
            },
            {
              id: 's2',
              conversationId: 'c2',
              title: 'Второй чат',
              status: 'active',
              messageCount: 4,
              createdAt: '2026-06-03T11:00:00Z',
              updatedAt: '2026-06-03T11:01:00Z',
            },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({
        values: { searchHistoryEnabled: true, searchHistoryLimit: 8 },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App gatewayUrl="https://gateway.example" />);

    expect(screen.getByPlaceholderText('Введите вопрос...')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Чат' }));

    expect(await screen.findByPlaceholderText('Введите сообщение...')).toBeVisible();
    expect(await screen.findByText('Первый чат')).toBeVisible();
    expect(screen.getByText('Второй чат')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/api/chat/sessions?status=active&limit=20',
      { credentials: 'include' }
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Поиск' }));

    expect(screen.getByPlaceholderText('Введите вопрос...')).toBeVisible();
    expect(screen.getByText('Первый чат')).not.toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Чат' }));

    expect(screen.getByText('Первый чат')).toBeVisible();
    expect(screen.getByText('Второй чат')).toBeVisible();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/chat/sessions')).length).toBe(1);
  });
});
