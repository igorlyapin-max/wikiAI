import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatTab from './ChatTab';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      lines.forEach((line) => controller.enqueue(encoder.encode(line)));
      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

describe('ChatTab', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('загружает список активных чатов', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({
      values: [
        {
          id: 's1',
          conversationId: 'c1',
          title: 'Вопрос по HR',
          status: 'active',
          messageCount: 2,
          createdAt: '2026-06-03T10:00:00Z',
          updatedAt: '2026-06-03T10:01:00Z',
        },
      ],
    })));
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);

    expect(await screen.findByText('Вопрос по HR')).toBeInTheDocument();
    expect(screen.getByText('2 сообщений')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/api/chat/sessions?status=active&limit=20',
      { credentials: 'include' }
    );
  });

  it('открывает archived session в режиме только чтение', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ values: [] }))
      .mockResolvedValueOnce(jsonResponse({
        values: [
          {
            id: 'arch-1',
            conversationId: 'arch-c1',
            title: 'Архивный чат',
            status: 'archived',
            messageCount: 1,
            createdAt: '2026-06-03T10:00:00Z',
            updatedAt: '2026-06-03T10:00:00Z',
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        values: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'Старый ответ',
            createdAt: '2026-06-03T10:00:00Z',
          },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.click(screen.getByRole('button', { name: 'Архив' }));
    await userEvent.click(await screen.findByRole('button', { name: /Архивный чат/ }));

    expect(await screen.findByText('Старый ответ')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Архивный чат доступен только для чтения')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });

  it('отправляет сообщение и рендерит streaming ответ, sources и conflict warning', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ values: [] }))
      .mockResolvedValueOnce(streamResponse([
        'data: {"type":"conversation","conversationId":"c-stream"}\n',
        'data: {"type":"diagnostics","diagnostics":{"originalMessage":"Что актуально?","retrievalQuery":"Что актуально?\\nПредыдущий вопрос: Старый вопрос","historyMessagesUsed":1,"requestedTopK":null,"effectiveTopK":4,"searchMode":"hybrid","rawChunks":3,"readableChunks":2,"trustedChunks":1,"finalSources":1}}\n',
        'data: {"type":"token","content":"Ответ"}\n',
        'data: {"type":"token","content":" готов"}\n',
        'data: {"type":"conflict","conflict":{"hasConflict":true,"lowTrust":true,"confidence":0.82,"summary":"Есть расхождение","conflictingSources":[{"title":"Черновик","claim":"Старое значение","trustScore":0.31}],"recommendedSourceTitle":"Регламент","lowTrustReason":"Источник требует проверки"}}\n',
        'data: {"type":"sources","sources":[{"title":"Регламент","pageId":7,"pageUrl":"https://wiki.example/Reglament"}]}\n',
        'data: [DONE]\n',
      ]))
      .mockResolvedValueOnce(jsonResponse({
        values: [
          {
            id: 's-stream',
            conversationId: 'c-stream',
            title: 'Новый чат',
            status: 'active',
            messageCount: 2,
            createdAt: '2026-06-03T10:00:00Z',
            updatedAt: '2026-06-03T10:01:00Z',
          },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.type(screen.getByPlaceholderText('Введите сообщение...'), 'Что актуально?');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByText('Ответ готов')).toBeInTheDocument();
    expect(screen.getByText('Есть расхождение')).toBeInTheDocument();
    expect(screen.getByText('Найдены противоречия и снижена надежность источников')).toBeInTheDocument();
    expect(screen.getByText('Приоритетный источник: Регламент')).toBeInTheDocument();
    expect(screen.getByText('Источник требует проверки')).toBeInTheDocument();
    expect(screen.getByText('Черновик').closest('li')).toHaveTextContent('Черновик, trust 0.31: Старое значение');
    expect(screen.getByRole('link', { name: 'Регламент' })).toHaveAttribute('href', 'https://wiki.example/Reglament');
    expect(screen.getByText('Источники подобраны по текущему сообщению и истории диалога (1).')).toBeInTheDocument();
    expect(screen.getByText('Retrieval: режим hybrid, topK 4')).toBeInTheDocument();
    expect(screen.getByText('Что актуально? Предыдущий вопрос: Старый вопрос')).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/api/chat', expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ message: 'Что актуально?' }),
      }));
    });
  });

  it('делает inline citation ссылкой на источник с тем же номером', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ values: [] }))
      .mockResolvedValueOnce(streamResponse([
        'data: {"type":"conversation","conversationId":"c-citation"}\n',
        'data: {"type":"token","content":"Карибский бассейн популярен для отдыха [3], но неизвестная ссылка [9] остается текстом."}\n',
        'data: {"type":"sources","sources":[{"title":"Источник 1","pageId":1,"pageUrl":"https://wiki.example/One"},{"title":"Источник 2","pageId":2},{"title":"Карибский бассейн","pageId":3,"pageUrl":"https://wiki.example/Caribbean"}]}\n',
        'data: [DONE]\n',
      ]))
      .mockResolvedValueOnce(jsonResponse({
        values: [
          {
            id: 's-citation',
            conversationId: 'c-citation',
            title: 'Цитаты',
            status: 'active',
            messageCount: 2,
            createdAt: '2026-06-03T10:00:00Z',
            updatedAt: '2026-06-03T10:01:00Z',
          },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.type(screen.getByPlaceholderText('Введите сообщение...'), 'Карибы');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByRole('link', { name: 'Открыть источник 3: Карибский бассейн' })).toHaveAttribute(
      'href',
      'https://wiki.example/Caribbean'
    );
    expect(screen.getByText(/неизвестная ссылка \[9\] остается текстом/)).toBeInTheDocument();
  });

  it('показывает ошибку истории чатов', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ message: 'История недоступна' }, 503)));
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);

    expect(await screen.findByText('История недоступна')).toBeInTheDocument();
  });

  it('выгружает архив чатов', async () => {
    const clickMock = vi.fn();
    const createObjectURLMock = vi.fn(() => 'blob:chat-archive');
    const revokeObjectURLMock = vi.fn();
    vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      const element = document.createElementNS('http://www.w3.org/1999/xhtml', tagName);
      if (tagName === 'a') {
        Object.defineProperty(element, 'click', { configurable: true, value: clickMock });
      }
      return element as HTMLElement;
    });
    vi.stubGlobal('URL', {
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ values: [] }))
      .mockResolvedValueOnce(jsonResponse({ values: [] }))
      .mockResolvedValueOnce(jsonResponse({ values: { content: '{"ok":true}' } }))
      .mockResolvedValueOnce(jsonResponse({ values: [] }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.click(screen.getByRole('button', { name: 'Архив' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Выгрузить архив' }));

    expect(createObjectURLMock).toHaveBeenCalledWith(expect.any(Blob));
    expect(clickMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:chat-archive');
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/api/chat/archive/export', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ format: 'json' }),
    }));
  });
});
