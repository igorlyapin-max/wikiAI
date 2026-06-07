import { act, render, screen, waitFor } from '@testing-library/react';
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

function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

  it('применяет режим интерфейса ассистента из UI config', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ui/config')) {
        return Promise.resolve(jsonResponse({ values: { assistantUiMode: 'compact' } }));
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<ChatTab gatewayUrl="https://gateway.example" />);

    await waitFor(() => {
      expect(container.querySelector('.ai-assistant__chat--compact')).toBeInTheDocument();
    });
  });

  it('не перетирает список чатов поздним ответом предыдущей загрузки', async () => {
    const activeRequest = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('status=active')) {
        return activeRequest.promise;
      }
      if (url.includes('status=archived')) {
        return Promise.resolve(jsonResponse({
          values: [
            {
              id: 'arch-1',
              conversationId: 'arch-c1',
              title: 'Архивный чат 1',
              status: 'archived',
              messageCount: 1,
              createdAt: '2026-06-03T10:00:00Z',
              updatedAt: '2026-06-03T10:00:00Z',
            },
            {
              id: 'arch-2',
              conversationId: 'arch-c2',
              title: 'Архивный чат 2',
              status: 'archived',
              messageCount: 3,
              createdAt: '2026-06-03T11:00:00Z',
              updatedAt: '2026-06-03T11:00:00Z',
            },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);

    await userEvent.click(screen.getByRole('button', { name: 'Архив' }));

    expect(await screen.findByText('Архивный чат 1')).toBeInTheDocument();
    expect(screen.getByText('Архивный чат 2')).toBeInTheDocument();

    await act(async () => {
      activeRequest.resolve(jsonResponse({
        values: [
          {
            id: 'active-late',
            conversationId: 'active-c1',
            title: 'Поздний активный чат',
            status: 'active',
            messageCount: 9,
            createdAt: '2026-06-03T09:00:00Z',
            updatedAt: '2026-06-03T09:00:00Z',
          },
        ],
      }));
      await activeRequest.promise;
    });

    expect(screen.queryByText('Поздний активный чат')).not.toBeInTheDocument();
    expect(screen.getByText('Архивный чат 1')).toBeInTheDocument();
    expect(screen.getByText('Архивный чат 2')).toBeInTheDocument();
  });

  it('открывает archived session в режиме только чтение', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ui/config')) {
        return Promise.resolve(jsonResponse({ assistantUiMode: 'standard' }));
      }
      if (url.includes('/api/chat/sessions?status=active')) {
        return Promise.resolve(jsonResponse({ values: [] }));
      }
      if (url.includes('/api/chat/sessions?status=archived')) {
        return Promise.resolve(jsonResponse({
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
        }));
      }
      if (url.includes('/api/chat/sessions/arch-1/messages')) {
        return Promise.resolve(jsonResponse({
          values: [
            {
              id: 'm1',
              role: 'assistant',
              content: 'Старый ответ',
              createdAt: '2026-06-03T10:00:00Z',
            },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    });
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
    let activeSessionRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ui/config')) {
        return Promise.resolve(jsonResponse({ assistantUiMode: 'standard' }));
      }
      if (url.endsWith('/api/chat')) {
        return Promise.resolve(streamResponse([
          'data: {"type":"conversation","conversationId":"c-stream"}\n',
          'data: {"type":"ui","assistantUiMode":"expert"}\n',
          'data: {"type":"diagnostics","diagnostics":{"originalMessage":"Что актуально?","retrievalQuery":"Что актуально?","retrievalQueryMode":"current_message","historyInjectedIntoRetrieval":false,"historyMessagesUsed":1,"requestedTopK":null,"retrievalTopK":4,"effectiveTopK":4,"contextTopK":2,"contextMaxChars":12000,"searchMode":"hybrid","rawChunks":3,"readableChunks":2,"trustedChunks":1,"finalSources":1,"contextSources":1,"tailSourcesBelowThreshold":1,"colbertScores":[{"id":7,"score":0.912},{"id":8,"score":0.541}]}}\n',
          'data: {"type":"token","content":"Ответ"}\n',
          'data: {"type":"token","content":" готов"}\n',
          'data: {"type":"conflict","conflict":{"hasConflict":true,"lowTrust":true,"confidence":0.82,"summary":"Есть расхождение","conflictingSources":[{"title":"Черновик","claim":"Старое значение","trustScore":0.31}],"recommendedSourceTitle":"Регламент","lowTrustReason":"Источник требует проверки"}}\n',
          'data: {"type":"sources","sources":[{"title":"Регламент","pageId":7,"pageUrl":"https://wiki.example/Reglament"}]}\n',
          'data: [DONE]\n',
        ]));
      }
      if (url.includes('/api/chat/sessions?status=active')) {
        activeSessionRequests += 1;
        if (activeSessionRequests === 1) {
          return Promise.resolve(jsonResponse({ values: [] }));
        }
        return Promise.resolve(jsonResponse({
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
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.type(screen.getByPlaceholderText('Введите сообщение...'), 'Что актуально?');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByText('Ответ готов')).toBeInTheDocument();
    expect(document.querySelector('.ai-assistant__chat--expert')).not.toBeNull();
    expect(screen.getByText('Есть расхождение')).toBeInTheDocument();
    expect(screen.getByText('Найдены противоречия и снижена надежность источников')).toBeInTheDocument();
    expect(screen.getByText('Приоритетный источник: Регламент')).toBeInTheDocument();
    expect(screen.getByText('Источник требует проверки')).toBeInTheDocument();
    expect(screen.getByText('Черновик').closest('li')).toHaveTextContent('Черновик, trust 0.31: Старое значение');
    expect(screen.getByRole('link', { name: 'Регламент' })).toHaveAttribute('href', 'https://wiki.example/Reglament');
    expect(screen.getByText('Источники подобраны по текущему сообщению. История учтена в ответе (1), но не в поисковом запросе.')).toBeInTheDocument();
    expect(screen.getByText('Retrieval: режим hybrid, выдача 4, контекст 1')).toBeInTheDocument();
    expect(screen.getAllByText('Что актуально?').length).toBeGreaterThan(0);
    expect(screen.getByText('historyInjectedIntoRetrieval')).toBeInTheDocument();
    expect(screen.getByText('ColBERT scores')).toBeInTheDocument();
    expect(screen.getByText('7:0.912, 8:0.541')).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/api/chat', expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ message: 'Что актуально?' }),
      }));
    });
  });

  it('заменяет streaming текст финальным message event и скрывает sources для no-answer', async () => {
    let activeSessionRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ui/config')) {
        return Promise.resolve(jsonResponse({ assistantUiMode: 'standard' }));
      }
      if (url.endsWith('/api/chat')) {
        return Promise.resolve(streamResponse([
          'data: {"type":"conversation","conversationId":"c-no-answer"}\n',
          'data: {"type":"diagnostics","diagnostics":{"retrievalQuery":"Что нового?","searchMode":"hybrid","effectiveTopK":5,"contextSources":1,"sourceDisplayMode":"no_answer_suppressed","suppressedSources":1,"suppressedCitationIndexes":[1]}}\n',
          'data: {"type":"token","content":"В предоставленных документах нет информации о новинках. [Источник 1]"}\n',
          'data: {"type":"message","content":"В предоставленных документах нет информации о новинках."}\n',
          'data: {"type":"sources","sources":[]}\n',
          'data: [DONE]\n',
        ]));
      }
      if (url.includes('/api/chat/sessions?status=active')) {
        activeSessionRequests += 1;
        if (activeSessionRequests === 1) {
          return Promise.resolve(jsonResponse({ values: [] }));
        }
        return Promise.resolve(jsonResponse({
          values: [
            {
              id: 's-no-answer',
              conversationId: 'c-no-answer',
              title: 'Новый чат',
              status: 'active',
              messageCount: 2,
              createdAt: '2026-06-03T10:00:00Z',
              updatedAt: '2026-06-03T10:01:00Z',
            },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.type(screen.getByPlaceholderText('Введите сообщение...'), 'Что нового?');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByText('В предоставленных документах нет информации о новинках.')).toBeInTheDocument();
    expect(screen.queryByText(/\[Источник 1\]/)).not.toBeInTheDocument();
    expect(screen.queryByText('Источники:')).not.toBeInTheDocument();
    expect(screen.getByText('Retrieval: режим hybrid, выдача 5, контекст 1')).toBeInTheDocument();
  });

  it('делает inline citation ссылкой на источник с тем же номером', async () => {
    let activeSessionRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ui/config')) {
        return Promise.resolve(jsonResponse({ assistantUiMode: 'standard' }));
      }
      if (url.endsWith('/api/chat')) {
        return Promise.resolve(streamResponse([
          'data: {"type":"conversation","conversationId":"c-citation"}\n',
          'data: {"type":"token","content":"Карибский бассейн популярен для отдыха [Источник 3], первый источник тоже доступен [источник 1], но неизвестная ссылка [Источник 9] остается текстом."}\n',
          'data: {"type":"sources","sources":[{"title":"Источник 1","pageId":1,"pageUrl":"https://wiki.example/One"},{"title":"Источник 2","pageId":2},{"title":"Карибский бассейн","pageId":3,"pageUrl":"https://wiki.example/Caribbean"}]}\n',
          'data: [DONE]\n',
        ]));
      }
      if (url.includes('/api/chat/sessions?status=active')) {
        activeSessionRequests += 1;
        if (activeSessionRequests === 1) {
          return Promise.resolve(jsonResponse({ values: [] }));
        }
        return Promise.resolve(jsonResponse({
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
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.type(screen.getByPlaceholderText('Введите сообщение...'), 'Карибы');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByRole('link', { name: 'Открыть источник 3: Карибский бассейн' })).toHaveAttribute(
      'href',
      'https://wiki.example/Caribbean'
    );
    expect(screen.getByRole('link', { name: 'Открыть источник 1: Источник 1' })).toHaveAttribute(
      'href',
      'https://wiki.example/One'
    );
    expect(screen.getByText(/неизвестная ссылка \[Источник 9\] остается текстом/)).toBeInTheDocument();
  });

  it('делает inline citation ссылкой по citationIndex и скрывает сгенерированный хвост Источники', async () => {
    let activeSessionRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ui/config')) {
        return Promise.resolve(jsonResponse({ assistantUiMode: 'standard' }));
      }
      if (url.endsWith('/api/chat')) {
        return Promise.resolve(streamResponse([
          'data: {"type":"conversation","conversationId":"c-filtered-citation"}\n',
          'data: {"type":"token","content":"Нужный документ найден [Источник 5].\\n\\nИсточники: [1] Лишний, [5] Нужный"}\n',
          'data: {"type":"sources","sources":[{"citationIndex":5,"title":"Нужный документ","pageId":5,"pageUrl":"https://wiki.example/Needed"}]}\n',
          'data: [DONE]\n',
        ]));
      }
      if (url.includes('/api/chat/sessions?status=active')) {
        activeSessionRequests += 1;
        if (activeSessionRequests === 1) {
          return Promise.resolve(jsonResponse({ values: [] }));
        }
        return Promise.resolve(jsonResponse({
          values: [
            {
              id: 's-filtered-citation',
              conversationId: 'c-filtered-citation',
              title: 'Цитата',
              status: 'active',
              messageCount: 2,
              createdAt: '2026-06-03T10:00:00Z',
              updatedAt: '2026-06-03T10:01:00Z',
            },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.type(screen.getByPlaceholderText('Введите сообщение...'), 'Найди документ');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByRole('link', { name: 'Открыть источник 5: Нужный документ' })).toHaveAttribute(
      'href',
      'https://wiki.example/Needed'
    );
    expect(screen.getByText(/^\[5\]/)).toBeInTheDocument();
    expect(screen.queryByText(/Лишний/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Источники: \[1\]/)).not.toBeInTheDocument();
  });

  it('показывает для attachment источник-файл и ссылку на страницу размещения', async () => {
    let activeSessionRequests = 0;
    const parentUrl = 'https://wiki.example/CorpCommon:%D0%9F%D1%80%D0%B8%D0%BA%D0%B0%D0%B7%D1%8B/%D0%A0%D0%B5%D0%B6%D0%B8%D0%BC_%D1%80%D0%B0%D0%B1%D0%BE%D1%87%D0%B5%D0%B3%D0%BE_%D0%B2%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%B8';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ui/config')) {
        return Promise.resolve(jsonResponse({ assistantUiMode: 'standard' }));
      }
      if (url.endsWith('/api/chat')) {
        return Promise.resolve(streamResponse([
          'data: {"type":"conversation","conversationId":"c-attachment-source"}\n',
          'data: {"type":"token","content":"Презентация найдена [Источник 1]."}\n',
          `data: {"type":"sources","sources":[{"title":"CorpCommon:Приказы/Режим рабочего времени","displayTitle":"Wikiai-architecture.pptx","pageId":53,"pageUrl":"${parentUrl}","sourceType":"attachment","attachmentFilename":"Wikiai-architecture.pptx","attachmentMime":"application/vnd.openxmlformats-officedocument.presentationml.presentation","parentPageTitle":"CorpCommon:Приказы/Режим рабочего времени","parentPageUrl":"${parentUrl}"}]}\n`,
          'data: [DONE]\n',
        ]));
      }
      if (url.includes('/api/chat/sessions?status=active')) {
        activeSessionRequests += 1;
        if (activeSessionRequests === 1) {
          return Promise.resolve(jsonResponse({ values: [] }));
        }
        return Promise.resolve(jsonResponse({
          values: [
            {
              id: 's-attachment-source',
              conversationId: 'c-attachment-source',
              title: 'PPTX',
              status: 'active',
              messageCount: 2,
              createdAt: '2026-06-03T10:00:00Z',
              updatedAt: '2026-06-03T10:01:00Z',
            },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatTab gatewayUrl="https://gateway.example" />);
    await screen.findByText('Чатов нет');

    await userEvent.type(screen.getByPlaceholderText('Введите сообщение...'), 'Wikiai-architecture.pptx');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByRole('link', { name: 'Открыть источник 1: Wikiai-architecture.pptx' })).toHaveAttribute(
      'href',
      parentUrl
    );
    expect(screen.getAllByText(/Wikiai-architecture\.pptx/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'CorpCommon:Приказы/Режим рабочего времени' })).toHaveAttribute(
      'href',
      parentUrl
    );
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
