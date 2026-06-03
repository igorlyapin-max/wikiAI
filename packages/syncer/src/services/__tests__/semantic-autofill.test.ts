import { describe, expect, it } from 'vitest';
import { applySemanticAutofillPatch } from '../semantic-autofill.js';

const content = `{{Корпоративный документ
|Департамент=
|Отдел=Service Desk
}}

= Регламент =
Текст страницы.`;

describe('semantic autofill patching', () => {
  it('fills an empty expected template parameter', () => {
    const result = applySemanticAutofillPatch(content, [{
      property: 'Департамент',
      value: 'ИТ-департамент',
      confidence: 0.91,
      expectedValue: '',
    }], ['Корпоративный документ']);

    expect(result.changed).toBe(true);
    expect(result.content).toContain('|Департамент=ИТ-департамент');
    expect(result.applied).toEqual([expect.objectContaining({
      property: 'Департамент',
      value: 'ИТ-департамент',
    })]);
  });

  it('does not overwrite when the value changed after evaluation', () => {
    const result = applySemanticAutofillPatch(content.replace('|Департамент=', '|Департамент=Финансы'), [{
      property: 'Департамент',
      value: 'ИТ-департамент',
      confidence: 0.91,
      expectedValue: '',
    }], ['Корпоративный документ']);

    expect(result.changed).toBe(false);
    expect(result.content).toContain('|Департамент=Финансы');
    expect(result.skipped).toEqual([{ property: 'Департамент', reason: 'current_value_changed' }]);
  });

  it('inserts a missing parameter before template close', () => {
    const result = applySemanticAutofillPatch(content, [{
      property: 'Критичность',
      value: 'Высокая',
      confidence: 0.88,
      expectedValue: '',
    }], ['Корпоративный документ']);

    expect(result.changed).toBe(true);
    expect(result.content).toContain('|Критичность=Высокая\n}}');
  });
});

