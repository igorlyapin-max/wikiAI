import { describe, expect, it } from 'vitest';
import { toIndexPlainText } from '../text-normalization.js';

describe('toIndexPlainText', () => {
  it('removes html-like tags while keeping their text and decoding entities', () => {
    expect(toIndexPlainText(
      'Запрос <code>древние цивилизации</code> найдет &lt;code&gt;Древний Египет&lt;/code&gt;.'
    )).toBe('Запрос древние цивилизации найдет Древний Египет.');
  });

  it('keeps fenced blocks intact for Mermaid and code-like content', () => {
    const input = [
      'Диаграмма <code>mermaid</code>',
      '```mermaid',
      'graph TD;',
      'A["<code>raw</code>"]-->B;',
      '```',
    ].join('\n');

    expect(toIndexPlainText(input)).toBe([
      'Диаграмма mermaid',
      [
        '```mermaid',
        'graph TD;',
        'A["<code>raw</code>"]-->B;',
        '```',
      ].join('\n'),
    ].join('\n\n'));
  });
});
