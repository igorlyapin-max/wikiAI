import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { upsertOntologyProperty } from '../ontology-vectors.js';
import {
  evaluateSemanticAutofill,
  getSemanticAutofillConfig,
  getSemanticAutofillStatus,
  recordSemanticAutofillApplied,
  resetSemanticAutofillOwnership,
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

  it('uses enabled managed block defaults', async () => {
    const config = await getSemanticAutofillConfig();

    expect(config).toMatchObject({
      enabled: true,
      mode: 'apply_empty',
      writeTarget: 'managed_block',
      managedTemplateName: 'WikiAI Semantic',
      managedBlockProfile: 'default',
      skipIfUserFactExists: true,
      insertPosition: 'end',
    });
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
      writeTarget: 'template_params',
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
      writeTarget: 'template_params',
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

  it('skips disabled namespaces, missing templates, and service edits before calling LLM', async () => {
    await setSemanticAutofillConfig({
      enabled: true,
      writeTarget: 'template_params',
      namespaces: [3010],
    });

    await expect(evaluateSemanticAutofill({
      pageId: 11,
      title: 'CorpIT:Service Desk/Регламент',
      namespace: 3030,
      content: pageContent(),
    })).resolves.toMatchObject({
      diagnostics: { skippedReason: 'namespace_not_enabled', llmCalled: false },
    });

    await setSemanticAutofillConfig({
      namespaces: [],
      templates: ['Другая карточка'],
    });
    await expect(evaluateSemanticAutofill({
      pageId: 12,
      title: 'CorpIT:Service Desk/Регламент',
      namespace: 3030,
      content: pageContent(),
    })).resolves.toMatchObject({
      diagnostics: { skippedReason: 'template_not_found', llmCalled: false },
    });

    await setSemanticAutofillConfig({
      templates: ['Корпоративный документ'],
    });
    await expect(evaluateSemanticAutofill({
      pageId: 13,
      title: 'CorpIT:Service Desk/Регламент',
      namespace: 3030,
      summary: 'WikiAI semantic autofill applied fields',
      content: pageContent(),
    })).resolves.toMatchObject({
      diagnostics: { skippedReason: 'service_edit', llmCalled: false },
    });
    expect(callLiteLLM).not.toHaveBeenCalled();
  });

  it('records suggested ownership, filters status, and resets ownership by property', async () => {
    await recordSemanticAutofillApplied({
      pageId: 20,
      title: 'CorpIT:Service Desk/Регламент',
      revId: 201,
      fields: [
        { property: 'Департамент', value: 'ИТ-департамент', confidence: 0.9, evidence: 'Service Desk' },
        { property: 'Система', value: 'Service Desk', confidence: 0.85 },
      ],
    });

    await expect(getSemanticAutofillStatus({
      state: 'auto',
      property: 'Департамент',
      title: 'Service Desk',
      limit: 10,
    })).resolves.toMatchObject({
      summary: {
        auto: 2,
        user: 0,
        suggested: 0,
        disabled: 0,
      },
      total: 2,
      records: [
        expect.objectContaining({
          pageId: 20,
          property: 'Департамент',
          lastAiValue: 'ИТ-департамент',
        }),
      ],
    });

    await expect(resetSemanticAutofillOwnership({
      pageId: 20,
      property: 'Департамент',
    }, 'TestAdmin')).resolves.toEqual({ updated: 1 });
    await expect(resetSemanticAutofillOwnership({})).rejects.toThrow(
      'At least one of pageId, title or property is required'
    );
  });

  it('suggests a managed block for a page without a document template', async () => {
    await upsertOntologyProperty({
      name: 'Департамент',
      indexed: true,
      aiExtractable: true,
      sensitive: false,
      classificationThreshold: 0.7,
    });
    await setSemanticAutofillConfig({
      enabled: true,
      mode: 'apply_empty',
      writeTarget: 'managed_block',
      minConfidence: 0.8,
    });
    callLiteLLM.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            fields: [{
              property: 'Департамент',
              value: 'ИТ-департамент',
              confidence: 0.91,
              evidence: 'Текст про Service Desk.',
            }],
          }),
        },
      }],
    });

    const result = await evaluateSemanticAutofill({
      pageId: 30,
      title: 'Тест семантики',
      namespace: 0,
      revId: 301,
      content: 'Тест семантики Service Desk',
      semanticFacts: {},
    });

    expect(result.writeTarget).toBe('managed_block');
    expect(result.managedBlock).toMatchObject({ templateName: 'WikiAI Semantic', profile: 'default' });
    expect(result.diagnostics.targetStatus).toBe('managed_block_missing');
    expect(result.patch).toEqual([expect.objectContaining({
      property: 'Департамент',
      value: 'ИТ-департамент',
      expectedValue: '',
    })]);
  });

  it('does not classify a property when the user already owns a direct SMW fact outside the managed block', async () => {
    await upsertOntologyProperty({
      name: 'Департамент',
      indexed: true,
      aiExtractable: true,
      sensitive: false,
    });
    await setSemanticAutofillConfig({
      enabled: true,
      mode: 'apply_empty',
      writeTarget: 'managed_block',
      skipIfUserFactExists: true,
    });
    callLiteLLM.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            fields: [{
              property: 'Департамент',
              value: 'ИТ-департамент',
              confidence: 0.95,
            }],
          }),
        },
      }],
    });

    const result = await evaluateSemanticAutofill({
      pageId: 31,
      title: 'Тест семантики',
      namespace: 0,
      revId: 302,
      content: 'Текст\n[[Департамент::Финансы]]',
      semanticFacts: { Департамент: ['Финансы'] },
    });

    expect(result.diagnostics.skippedFields).toContainEqual({
      property: 'Департамент',
      reason: 'user_fact_exists',
    });
    expect(result.patch.find((item) => item.property === 'Департамент')).toBeUndefined();
    expect(callLiteLLM).toHaveBeenCalledTimes(1);
  });

  it('locks a manually changed managed block value', async () => {
    await upsertOntologyProperty({
      name: 'Департамент',
      indexed: true,
      aiExtractable: true,
      sensitive: false,
    });
    await setSemanticAutofillConfig({
      enabled: true,
      mode: 'apply_empty',
      writeTarget: 'managed_block',
    });
    await recordSemanticAutofillApplied({
      pageId: 32,
      title: 'Тест семантики',
      revId: 303,
      fields: [{ property: 'Департамент', value: 'ИТ-департамент', confidence: 0.9 }],
    });

    const result = await evaluateSemanticAutofill({
      pageId: 32,
      title: 'Тест семантики',
      namespace: 0,
      revId: 304,
      content: `Text

<!-- WikiAI:semantic:start {"version":1,"profile":"default"} -->
{{WikiAI Semantic
|Департамент=Финансы
}}
<!-- WikiAI:semantic:end -->`,
      semanticFacts: { Департамент: ['Финансы'] },
    });

    expect(result.lockedFields).toContainEqual(expect.objectContaining({
      property: 'Департамент',
      state: 'user',
      reason: 'manual_override',
    }));
    expect(result.patch).toEqual([]);
  });
});
