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

  it('appends a managed WikiAI semantic block when it is missing', () => {
    const result = applySemanticAutofillPatch('= Регламент =\nТекст страницы.', [{
      property: 'Департамент',
      value: 'ИТ-департамент',
      confidence: 0.91,
      expectedValue: '',
    }], {
      writeTarget: 'managed_block',
      templates: ['Корпоративный документ'],
      managedBlock: { templateName: 'WikiAI Semantic', profile: 'default', insertPosition: 'end' },
    });

    expect(result.changed).toBe(true);
    expect(result.content).toContain('<!-- WikiAI:semantic:start {"version":1,"profile":"default"} -->');
    expect(result.content).toContain('{{WikiAI Semantic\n|Департамент=ИТ-департамент\n}}');
    expect(result.content).toContain('<!-- WikiAI:semantic:end -->');
  });

  it('replaces only the existing managed block content', () => {
    const page = `Intro

<!-- WikiAI:semantic:start {"version":1,"profile":"default"} -->
{{WikiAI Semantic
|Департамент=ИТ-департамент
|Статус документа=Черновик
}}
<!-- WikiAI:semantic:end -->

[[Департамент::Финансы]]
Outro`;
    const result = applySemanticAutofillPatch(page, [{
      property: 'Статус документа',
      value: 'Утвержден',
      confidence: 0.9,
      expectedValue: 'Черновик',
    }], {
      writeTarget: 'managed_block',
      templates: ['Корпоративный документ'],
      managedBlock: { templateName: 'WikiAI Semantic', profile: 'default', insertPosition: 'end' },
    });

    expect(result.changed).toBe(true);
    expect(result.content).toContain('|Департамент=ИТ-департамент');
    expect(result.content).toContain('|Статус документа=Утвержден');
    expect(result.content).toContain('[[Департамент::Финансы]]');
    expect(result.content.match(/WikiAI:semantic:start/g)).toHaveLength(1);
  });

  it('does not write when managed block markers are corrupt', () => {
    const result = applySemanticAutofillPatch('Text\n<!-- WikiAI:semantic:start {"version":1} -->', [{
      property: 'Департамент',
      value: 'ИТ-департамент',
      confidence: 0.9,
      expectedValue: '',
    }], {
      writeTarget: 'managed_block',
      templates: ['Корпоративный документ'],
      managedBlock: { templateName: 'WikiAI Semantic', profile: 'default', insertPosition: 'end' },
    });

    expect(result.changed).toBe(false);
    expect(result.skipped).toEqual([{ property: 'Департамент', reason: 'managed_block_corrupt' }]);
  });
});
