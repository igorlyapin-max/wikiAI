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

export interface ChatCompletionRequestOptions {
  temperature?: number;
  maxTokens?: number;
}

export type LiteLLMMessage = { role: string; content: string };

export interface LiteLLMChatRequestBody {
  model: string;
  messages: LiteLLMMessage[];
  stream: boolean;
  temperature: number;
  max_tokens: number;
}

export interface LiteLLMRequestEnvelope {
  method: 'POST';
  url: string;
  timeoutMs: number;
  headers: Record<string, string>;
  body: LiteLLMChatRequestBody;
}

export interface LiteLLMResponseEnvelope {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface LiteLLMChatTrace {
  request: LiteLLMRequestEnvelope;
  response?: LiteLLMResponseEnvelope;
}

export interface TracedChatCompletionResult {
  response?: ChatCompletionResponse;
  error?: string;
  trace: LiteLLMChatTrace;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function maskHeaderValue(key: string, value: string): string {
  if (/authorization|cookie|token|secret|api[-_]?key/i.test(key)) {
    if (key.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
      return 'Bearer [redacted]';
    }
    return '[redacted]';
  }
  return value;
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, maskHeaderValue(key, value)])
  );
}

export function maskLiteLLMTrace(trace: LiteLLMChatTrace): LiteLLMChatTrace {
  return {
    request: {
      ...trace.request,
      headers: maskHeaders(trace.request.headers),
    },
    ...(trace.response ? {
      response: {
        ...trace.response,
        headers: maskHeaders(trace.response.headers),
      },
    } : {}),
  };
}

async function buildLiteLLMRequestEnvelope(
  messages: LiteLLMMessage[],
  stream: boolean,
  model?: string,
  timeoutMs?: number,
  options: ChatCompletionRequestOptions = {}
): Promise<LiteLLMRequestEnvelope> {
  const effectiveConfig = await getEffectiveLlmConfig();
  const url = buildServiceUrl(effectiveConfig.baseUrl, 'chat/completions');
  const effectiveTimeout = timeoutMs ?? effectiveConfig.timeoutMs;
  const temperature = options.temperature ?? effectiveConfig.temperature;
  const maxTokens = options.maxTokens ?? effectiveConfig.maxTokens;

  return {
    method: 'POST',
    url,
    timeoutMs: effectiveTimeout,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${effectiveConfig.apiKey}`,
      ...currentTraceHeaders(),
    },
    body: {
      model: model ?? effectiveConfig.model,
      messages,
      stream,
      temperature,
      max_tokens: maxTokens,
    },
  };
}

async function fetchLiteLLMJson(
  request: LiteLLMRequestEnvelope,
  operation: 'chat' | 'stream_chat',
  signal: AbortSignal
): Promise<{ response: Response; body: unknown }> {
  const response = await measureDependency({ dependency: 'litellm', operation }, async () => fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  }));
  const text = await response.text().catch(() => '');
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { response, body };
}

function responseEnvelope(response: Response, body: unknown): LiteLLMResponseEnvelope {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    body,
  };
}

export async function* streamChatCompletion(
  messages: Array<{ role: string; content: string }>,
  model?: string,
  timeoutMs?: number,
  options: ChatCompletionRequestOptions = {}
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  const request = await buildLiteLLMRequestEnvelope(messages, true, model, timeoutMs, options);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const res = await measureDependency({ dependency: 'litellm', operation: 'stream_chat' }, async () => fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
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
      throw new Error(`LiteLLM request timed out after ${request.timeoutMs}ms`);
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
  messages: LiteLLMMessage[],
  model?: string,
  timeoutMs?: number,
  options: ChatCompletionRequestOptions = {}
): Promise<ChatCompletionResponse> {
  const traced = await callLiteLLMWithTrace(messages, model, timeoutMs, options);
  if (traced.response) return traced.response;
  throw new Error(traced.error ?? 'Unknown LiteLLM error');
}

export async function callLiteLLMWithTrace(
  messages: LiteLLMMessage[],
  model?: string,
  timeoutMs?: number,
  options: ChatCompletionRequestOptions = {}
): Promise<TracedChatCompletionResult> {
  const request = await buildLiteLLMRequestEnvelope(messages, false, model, timeoutMs, options);
  const trace: LiteLLMChatTrace = { request };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const { response: res, body } = await fetchLiteLLMJson(request, 'chat', controller.signal);
    clearTimeout(timeoutId);
    trace.response = responseEnvelope(res, body);

    if (!res.ok) {
      const detail = typeof body === 'string' ? body : JSON.stringify(body);
      return {
        error: `LiteLLM error: ${res.status} ${detail || res.statusText}`,
        trace: maskLiteLLMTrace(trace),
      };
    }

    return {
      response: body as ChatCompletionResponse,
      trace: maskLiteLLMTrace(trace),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        error: `LiteLLM request timed out after ${request.timeoutMs}ms`,
        trace: maskLiteLLMTrace(trace),
      };
    }
    return {
      error: err instanceof Error ? err.message : 'Unknown LiteLLM error',
      trace: maskLiteLLMTrace(trace),
    };
  }
}
