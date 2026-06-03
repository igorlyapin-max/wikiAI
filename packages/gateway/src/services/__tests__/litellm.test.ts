import { afterEach, describe, expect, it, vi } from 'vitest';

const getEffectiveLlmConfig = vi.hoisted(() => vi.fn());

vi.mock('../admin-platform-config.js', () => ({
  getEffectiveLlmConfig,
  buildServiceUrl: (baseUrl: string, path: string) => new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(),
}));

function llmConfig() {
  return {
    baseUrl: 'http://litellm.local/v1',
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.1,
    maxTokens: 256,
    timeoutMs: 1000,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('LiteLLM client', () => {
  it('calls chat completions with the effective non-streaming config', async () => {
    getEffectiveLlmConfig.mockResolvedValue(llmConfig());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { callLiteLLM } = await import('../litellm.js');
    await expect(callLiteLLM([{ role: 'user', content: 'healthcheck' }])).resolves.toMatchObject({
      choices: [{ message: { content: 'OK' } }],
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://litellm.local/v1/chat/completions');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-key',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'test-model',
      stream: false,
      temperature: 0.1,
      max_tokens: 256,
    });
  });

  it('throws a useful error for non-OK chat responses', async () => {
    getEffectiveLlmConfig.mockResolvedValue(llmConfig());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad upstream', { status: 502, statusText: 'Bad Gateway' })));

    const { callLiteLLM } = await import('../litellm.js');
    await expect(callLiteLLM([{ role: 'user', content: 'x' }])).rejects.toThrow('LiteLLM error: 502 bad upstream');
  });

  it('parses streaming SSE chunks and ignores malformed lines', async () => {
    getEffectiveLlmConfig.mockResolvedValue(llmConfig());
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}],"id":"1","object":"chat.completion.chunk","created":1,"model":"m"}\n',
          'data: not-json\n',
          'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}],"id":"2","object":"chat.completion.chunk","created":1,"model":"m"}\n',
          'data: [DONE]\n\n',
        ].join('')));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const { streamChatCompletion } = await import('../litellm.js');
    const chunks = [];
    for await (const chunk of streamChatCompletion([{ role: 'user', content: 'x' }])) {
      chunks.push(chunk.choices[0]?.delta.content);
    }

    expect(chunks).toEqual(['Hel', 'lo']);
  });

  it('normalizes AbortError into a timeout message', async () => {
    getEffectiveLlmConfig.mockResolvedValue(llmConfig());
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw abortError;
    }));

    const { callLiteLLM } = await import('../litellm.js');
    await expect(callLiteLLM([{ role: 'user', content: 'x' }], undefined, 25)).rejects.toThrow(
      'LiteLLM request timed out after 25ms'
    );
  });
});
