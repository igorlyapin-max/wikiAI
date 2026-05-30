import { config } from '../config.js';

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

export async function* streamChatCompletion(
  messages: Array<{ role: string; content: string }>,
  model?: string,
  timeoutMs?: number
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  const url = `${config.litellmBaseUrl}/chat/completions`;
  const effectiveTimeout = timeoutMs ?? 30000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.litellmApiKey}`,
      },
      body: JSON.stringify({
        model: model ?? config.litellmModel,
        messages,
        stream: true,
        temperature: 0.3,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`LiteLLM error: ${res.status} ${text}`);
    }

    if (!res.body) {
      throw new Error('LiteLLM response has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const chunk: ChatCompletionChunk = JSON.parse(jsonStr);
              if (chunk.choices?.[0]?.delta?.content) {
                yield chunk;
              }
            } catch {
              // ignore malformed JSON lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LiteLLM request timed out after ${effectiveTimeout}ms`);
    }
    throw err;
  }
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string | null;
  }>;
}

export async function callLiteLLM(
  messages: Array<{ role: string; content: string }>,
  model?: string,
  timeoutMs?: number
): Promise<ChatCompletionResponse> {
  const url = `${config.litellmBaseUrl}/chat/completions`;
  const effectiveTimeout = timeoutMs ?? 30000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.litellmApiKey}`,
      },
      body: JSON.stringify({
        model: model ?? config.litellmModel,
        messages,
        stream: false,
        temperature: 0.3,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`LiteLLM error: ${res.status} ${text}`);
    }

    return res.json() as Promise<ChatCompletionResponse>;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LiteLLM request timed out after ${effectiveTimeout}ms`);
    }
    throw err;
  }
}
