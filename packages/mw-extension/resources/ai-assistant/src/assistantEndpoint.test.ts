import { describe, expect, it } from 'vitest';
import { createAssistantEndpoint } from './assistantEndpoint';

describe('createAssistantEndpoint', () => {
  it('строит direct Gateway URL без trailing slash', () => {
    const endpoint = createAssistantEndpoint({ gatewayUrl: 'https://gateway.example/' });

    expect(endpoint('/api/chat')).toBe('https://gateway.example/api/chat');
  });

  it('строит same-origin MediaWiki proxy URL и сохраняет query string целевого endpoint', () => {
    const endpoint = createAssistantEndpoint({
      gatewayUrl: 'http://192.168.202.35:3000',
      proxyEnabled: true,
      proxyBase: '/index.php/Special:AIAssistant',
      locationHref: 'http://192.168.202.35:8082/index.php/Special:AIAssistant',
    });

    const url = new URL(endpoint('/api/chat/sessions?status=active&limit=20'));

    expect(url.origin).toBe('http://192.168.202.35:8082');
    expect(url.pathname).toBe('/index.php/Special:AIAssistant');
    expect(url.searchParams.get('aiassistant-proxy')).toBe('1');
    expect(url.searchParams.get('path')).toBe('/api/chat/sessions?status=active&limit=20');
  });
});
