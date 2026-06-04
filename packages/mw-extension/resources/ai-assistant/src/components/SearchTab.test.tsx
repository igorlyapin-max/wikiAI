import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SearchTab from './SearchTab';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SearchTab', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('не отправляет пустой запрос', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({
      values: { searchHistoryEnabled: true, searchHistoryLimit: 8 },
    })));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/api/ui/config', { credentials: 'include' });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('рендерит результаты поиска и ссылку на страницу', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        values: { searchHistoryEnabled: true, searchHistoryLimit: 8 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        diagnostics: {
          retrievalQuery: 'ИТ регламент',
          searchMode: 'hybrid',
          requestedTopK: 5,
          effectiveTopK: 5,
          rawChunks: 3,
          readableChunks: 2,
          trustedChunks: 1,
          finalResults: 1,
          retrievalProfileId: null,
        },
        results: [
          {
            id: 'r1',
            pageId: 42,
            title: 'Регламент ИТ',
            pageUrl: 'https://wiki.example/Reglament',
            text: 'Описание регламента',
          },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);
    await userEvent.type(screen.getByPlaceholderText('Введите вопрос...'), 'ИТ регламент');
    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));

    expect(await screen.findByText('Регламент ИТ')).toBeInTheDocument();
    expect(screen.getByText('Найдено 1, режим hybrid, topK 5')).toBeInTheDocument();
    expect(screen.getByText('raw/readable/trusted')).toBeInTheDocument();
    expect(screen.getByText('3 / 2 / 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть страницу' })).toHaveAttribute(
      'href',
      'https://wiki.example/Reglament'
    );
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query: 'ИТ регламент', topK: 5 }),
    });
  });

  it('нормализует неполный результат поиска', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        values: { searchHistoryEnabled: true, searchHistoryLimit: 8 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        results: [
          'ignored',
          {
            pageId: 0,
          },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);
    await userEvent.type(screen.getByPlaceholderText('Введите вопрос...'), 'без заголовка');
    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));

    expect(await screen.findByText('Страница 2')).toBeInTheDocument();
  });

  it('показывает empty state без результатов', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        values: { searchHistoryEnabled: true, searchHistoryLimit: 8 },
      }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);
    await userEvent.type(screen.getByPlaceholderText('Введите вопрос...'), 'нет совпадений');
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('показывает ошибку Gateway', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        values: { searchHistoryEnabled: true, searchHistoryLimit: 8 },
      }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Нет доступа' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);
    await userEvent.type(screen.getByPlaceholderText('Введите вопрос...'), 'секрет');
    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));

    await waitFor(() => {
      expect(screen.getByText('Нет доступа')).toBeInTheDocument();
    });
  });

  it('показывает status-based ошибку, если Gateway не вернул JSON message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        values: { searchHistoryEnabled: true, searchHistoryLimit: 8 },
      }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);
    await userEvent.type(screen.getByPlaceholderText('Введите вопрос...'), 'ошибка');
    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));

    expect(await screen.findByText('Ошибка Gateway (502)')).toBeInTheDocument();
  });

  it('запоминает успешные запросы, дедуплицирует их и соблюдает лимит', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        values: { searchHistoryEnabled: true, searchHistoryLimit: 2 },
      }))
      .mockImplementation(() => Promise.resolve(jsonResponse({ results: [] })));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/api/ui/config', { credentials: 'include' });
    });

    const input = screen.getByPlaceholderText('Введите вопрос...');
    await userEvent.type(input, 'первый');
    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));
    expect(await screen.findByRole('button', { name: 'Повторить поиск: первый' })).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, 'второй');
    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));
    expect(await screen.findByRole('button', { name: 'Повторить поиск: второй' })).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, 'Первый');
    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));

    expect(await screen.findByRole('button', { name: 'Повторить поиск: Первый' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить поиск: первый' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить поиск: второй' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('wikiai:searchHistory:v1') || '[]')).toEqual(['Первый', 'второй']);
  });

  it('очищает и скрывает историю, если настройка выключена', async () => {
    window.localStorage.setItem('wikiai:searchHistory:v1', JSON.stringify(['старый']));
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({
      values: { searchHistoryEnabled: false, searchHistoryLimit: 8 },
    })));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);

    await waitFor(() => {
      expect(window.localStorage.getItem('wikiai:searchHistory:v1')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Повторить поиск: старый' })).not.toBeInTheDocument();
  });

  it('повторяет поиск по клику на последний запрос', async () => {
    window.localStorage.setItem('wikiai:searchHistory:v1', JSON.stringify(['регламент']));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        values: { searchHistoryEnabled: true, searchHistoryLimit: 8 },
      }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchTab gatewayUrl="https://gateway.example" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Повторить поиск: регламент' }));

    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/api/search', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ query: 'регламент', topK: 5 }),
    }));
  });
});
