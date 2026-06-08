import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const specialPagePath = path.resolve(process.cwd(), '../../src/SpecialAIAssistant.php');
const specialPageSource = fs.readFileSync(specialPagePath, 'utf8');

describe('SpecialAIAssistant proxy contract', () => {
  it('публикует same-origin proxy атрибуты для frontend shell', () => {
    expect(specialPageSource).toContain("getCheck('aiassistant-proxy')");
    expect(specialPageSource).toContain('data-proxy-enabled');
    expect(specialPageSource).toContain('data-proxy-base');
    expect(specialPageSource).toContain("SpecialPage::getTitleFor('AIAssistant')->getLocalURL()");
  });

  it('проксирует только пользовательские assistant endpoint-ы', () => {
    expect(specialPageSource).toContain("'/api/ui/config'");
    expect(specialPageSource).toContain("'/api/search'");
    expect(specialPageSource).toContain("'/api/chat'");
    expect(specialPageSource).toContain("'/api/chat/sessions'");
    expect(specialPageSource).toContain("'/api/chat/archive/export'");
    expect(specialPageSource).toContain("preg_match('#^/api/chat/sessions/[^/?]+/messages$#'");
    expect(specialPageSource).toContain("!in_array($method, ['GET', 'POST'], true)");
    expect(specialPageSource).toContain("setHeader('Cookie', $cookie)");
  });
});
