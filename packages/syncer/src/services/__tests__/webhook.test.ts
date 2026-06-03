import { describe, expect, it } from 'vitest';
import { getWebhookTitle, normalizeEvent } from '../webhook.js';

describe('webhook contract', () => {
  it('keeps canonical event names', () => {
    expect(normalizeEvent('edit')).toBe('edit');
    expect(normalizeEvent('delete')).toBe('delete');
    expect(normalizeEvent('move')).toBe('move');
    expect(normalizeEvent('protect')).toBe('protect');
  });

  it('accepts legacy MediaWiki event aliases', () => {
    expect(normalizeEvent('page_save')).toBe('edit');
    expect(normalizeEvent('page_delete')).toBe('delete');
    expect(normalizeEvent('page_move')).toBe('move');
    expect(normalizeEvent('page_protect')).toBe('protect');
  });

  it('uses title before new_title', () => {
    expect(getWebhookTitle({ title: 'A', new_title: 'B' })).toBe('A');
    expect(getWebhookTitle({ new_title: 'B' })).toBe('B');
    expect(getWebhookTitle({})).toBeNull();
  });
});
