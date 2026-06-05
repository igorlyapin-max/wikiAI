import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const assistantCss = fs.readFileSync(path.resolve(process.cwd(), 'src/assistant.css'), 'utf8');

describe('assistant CSS theme contract', () => {
  it('uses MediaWiki-compatible theme tokens instead of dark standalone actions', () => {
    expect(assistantCss).toContain('--ai-color-base: var(--color-base, #202122);');
    expect(assistantCss).toContain('--ai-progressive: var(--color-progressive, #36c);');
    expect(assistantCss).toContain('--ai-surface-subtle: var(--background-color-neutral-subtle, #f8f9fa);');
    expect(assistantCss).not.toContain('#111827');
    expect(assistantCss).not.toMatch(/#7c3aed/i);
  });

  it('keeps primary controls and user bubbles on wiki progressive styling', () => {
    expect(assistantCss).toMatch(
      /\.ai-assistant__button--primary\s*\{[\s\S]*?background:\s*var\(--ai-progressive-bg\);/
    );
    expect(assistantCss).toMatch(
      /\.ai-assistant__tab--active\s*\{[\s\S]*?box-shadow:\s*inset 0 -2px 0 var\(--ai-border-progressive\);/
    );
    expect(assistantCss).toMatch(
      /\.ai-assistant__message--user \.ai-assistant__bubble\s*\{[\s\S]*?background:\s*var\(--ai-progressive-subtle\);/
    );
  });
});
