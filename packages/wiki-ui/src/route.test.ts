import { describe, expect, it } from 'vitest';
import { routeFromPathname, routeHref } from './route';

describe('wiki UI routing', () => {
  it('maps assistant routes to the assistant page', () => {
    expect(routeFromPathname('/ai')).toBe('assistant');
    expect(routeFromPathname('/ai/')).toBe('assistant');
    expect(routeFromPathname('/ai/assistant')).toBe('assistant');
  });

  it('maps admin routes to the admin page', () => {
    expect(routeFromPathname('/ai/admin')).toBe('admin');
    expect(routeFromPathname('/admin')).toBe('admin');
  });

  it('builds same-origin route hrefs', () => {
    expect(routeHref('assistant')).toBe('/ai/assistant');
    expect(routeHref('admin')).toBe('/ai/admin');
  });
});
