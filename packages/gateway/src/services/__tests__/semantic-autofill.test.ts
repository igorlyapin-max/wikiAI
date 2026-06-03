import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { upsertOntologyProperty } from '../ontology-vectors.js';
import {
  evaluateSemanticAutofill,
  recordSemanticAutofillApplied,
  setSemanticAutofillConfig,
} from '../semantic-autofill.js';

const callLiteLLM = vi.hoisted(() => vi.fn());

vi.mock('../litellm.js', () => ({
  callLiteLLM,
}));

function pageContent(value = ''): string {
  return `{{Корпоративный документ
|Департамент=${value}
|Отдел=Service Desk
|Тип документа=Регламент процесса
|Владелец процесса=Руководитель Service Desk
|Статус документа=Действует
|Система=Service Desk
|Процесс=Обработка обращений
|Дата действия=2026-05-31
|Критичность=Высокая
}}

= Регламент обработки заявок =

Service Desk обрабатывает обращения пользователей.`;
}

describe('semantic autofill', () => {
  beforeEach(() => {
    resetAdminStoreForTests();
    callLiteLLM.mockReset();
  });

  it('stays disabled by default and does not call LLM', async () => {
    const result = await evaluateSemanticAutofill({
      pageId: 10,
      title: 'CorpIT:Service Desk/Регламент',
      namespace: 3030,
      content: pageContent(),
      semanticFacts: {},
    });

    expect(result.enabled).toBe(false);
    expect(result.diagnostics.skippedReason).toBe('disabled');
    expect(callLiteLLM).not.toHaveBeenCalled();
  });

  it('suggests and patches empty fields in apply_empty mode', async () => {
    await upsertOntologyProperty({
      name: 'Департамент',
      indexed: true,
      aiExtractable: true,
      sensitive: false,
      description: 'Организационный департамент документа.',
    });
    await setSemanticAutofillConfig({
      enabled: true,
      mode: 'apply_empty',
      minConfidence: 0.8,
    });
    callLiteLLM.mockResolvedValueOnce({
      model: 'test-model',
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            fields: [{
              property: 'Департамент',
              value: 'ИТ-департамент',
              confidence: 0.91,
              evidence: 'Service Desk относится к ИТ.',
            }],
          }),
        },
      }],
    });

    const result = await evaluateSemanticAutofill({
      pageId: 10,
      title: 'CorpIT:Service Desk/Регламент',
      namespace: 3030,
      revId: 101,
      content: pageContent(),
      semanticFacts: {},
    });

    expect(result.enabled).toBe(true);
    expect(result.patch).toEqual([expect.objectContaining({
      property: 'Департамент',
      value: 'ИТ-департамент',
      expectedValue: '',
    })]);
    expect(callLiteLLM).toHaveBeenCalledTimes(1);
  });

  it('locks only the manually changed page field after AI ownership existed', async () => {
    await upsertOntologyProperty({
      name: 'Департамент',
      indexed: true,
      aiExtractable: true,
      sensitive: false,
    });
    await setSemanticAutofillConfig({
      enabled: true,
      mode: 'apply_empty',
    });
    await recordSemanticAutofillApplied({
      pageId: 10,
      title: 'CorpIT:Service Desk/Регламент',
      revId: 102,
      fields: [{ property: 'Департамент', value: 'ИТ-департамент', confidence: 0.9 }],
    });

    const result = await evaluateSemanticAutofill({
      pageId: 10,
      title: 'CorpIT:Service Desk/Регламент',
      namespace: 3030,
      revId: 103,
      editor: { username: 'Editor' },
      content: pageContent('Финансовый департамент'),
      semanticFacts: { Департамент: ['Финансовый департамент'] },
    });

    expect(result.lockedFields).toContainEqual(expect.objectContaining({
      property: 'Департамент',
      state: 'user',
      reason: 'manual_value',
    }));
    expect(result.patch.find((item) => item.property === 'Департамент')).toBeUndefined();
  });
});

