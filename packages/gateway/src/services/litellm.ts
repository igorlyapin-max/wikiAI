import { buildServiceUrl, getEffectiveLlmConfig } from './admin-platform-config.js';
import { measureDependency } from './metrics.js';
import { currentTraceHeaders } from './tracing.js';

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
  const effectiveConfig = await getEffectiveLlmConfig();
  const url = buildServiceUrl(effectiveConfig.baseUrl, 'chat/completions');
  const effectiveTimeout = timeoutMs ?? effectiveConfig.timeoutMs;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const res = await measureDependency({ dependency: 'litellm', operation: 'stream_chat' }, async () => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${effectiveConfig.apiKey}`,
        ...currentTraceHeaders(),
      },
      body: JSON.stringify({
        model: model ?? effectiveConfig.model,
        messages,
        stream: true,
        temperature: effectiveConfig.temperature,
        max_tokens: effectiveConfig.maxTokens,
      }),
      signal: controller.signal,
    }));

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
  const effectiveConfig = await getEffectiveLlmConfig();
  const url = buildServiceUrl(effectiveConfig.baseUrl, 'chat/completions');
  const effectiveTimeout = timeoutMs ?? effectiveConfig.timeoutMs;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const res = await measureDependency({ dependency: 'litellm', operation: 'chat' }, async () => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${effectiveConfig.apiKey}`,
        ...currentTraceHeaders(),
      },
      body: JSON.stringify({
        model: model ?? effectiveConfig.model,
        messages,
        stream: false,
        temperature: effectiveConfig.temperature,
        max_tokens: effectiveConfig.maxTokens,
      }),
      signal: controller.signal,
    }));

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
