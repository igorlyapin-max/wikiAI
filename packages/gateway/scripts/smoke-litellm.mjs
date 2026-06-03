if (process.env.RUN_LITELLM_SMOKE !== '1') {
  console.log('Skipping LiteLLM/OpenAI smoke; set RUN_LITELLM_SMOKE=1 to run it.');
  process.exit(0);
}

const baseUrl = process.env.LITELLM_BASE_URL;
const apiKey = process.env.LITELLM_API_KEY;
const model = process.env.LITELLM_MODEL;

if (!baseUrl || !apiKey || !model) {
  throw new Error('LITELLM_BASE_URL, LITELLM_API_KEY, and LITELLM_MODEL are required.');
}

const messages = [
  { role: 'system', content: 'Reply with the single word OK.' },
  { role: 'user', content: 'Health check.' },
];

async function nonStreamingSmoke() {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0,
      max_tokens: 32,
    }),
  });
  if (!res.ok) throw new Error(`LiteLLM non-stream failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('LiteLLM non-stream response had no content');
  }
  console.log('LiteLLM non-stream: ok');
}

async function streamingSmoke() {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0,
      max_tokens: 32,
    }),
  });
  if (!res.ok) throw new Error(`LiteLLM stream failed: ${res.status} ${await res.text()}`);
  if (!res.body) throw new Error('LiteLLM stream response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawContent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
      const payload = JSON.parse(trimmed.slice(6));
      const content = payload.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content.length > 0) sawContent = true;
    }
  }

  if (!sawContent) throw new Error('LiteLLM stream response had no token content');
  console.log('LiteLLM stream: ok');
}

await nonStreamingSmoke();
await streamingSmoke();
console.log('LiteLLM/OpenAI smoke completed.');
