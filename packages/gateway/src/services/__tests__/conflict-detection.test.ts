import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { setConflictDetectionConfig } from '../admin-platform-config.js';
import {
  analyzeAttachmentParentConflicts,
  buildConflictDetectionTestData,
  buildConflictInstruction,
  detectConflicts,
  detectConflictsForChat,
  detectConflictsWithTrace,
} from '../conflict-detection.js';
import { SearchChunk } from '../../types/index.js';

const callLiteLLM = vi.hoisted(() => vi.fn());

vi.mock('../litellm.js', () => ({
  callLiteLLM,
}));

describe('conflict detection', () => {
  const chunks: SearchChunk[] = [
    {
      id: 1,
      pageId: 10,
      title: 'CorpIT:Инструкция VPN',
      text: 'VPN requires MFA.',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      score: 0.95,
      trust: {
        modelId: 'default',
        score: 0.9,
        stalenessPenalty: 0,
        flags: ['official'],
        appliedEntityIds: [],
        appliedRuleIds: [],
        decisions: {
          includeInContext: true,
          allowDirectAnswer: true,
          excludeFromIndex: false,
          requireManualApproval: false,
          notifyAuthor: false,
          requireSources: true,
        },
      },
    },
    {
      id: 2,
      pageId: 11,
      title: 'CorpIT:FAQ VPN',
      text: 'Temporary VPN can be issued without MFA.',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      score: 0.88,
      trust: {
        modelId: 'default',
        score: 0.55,
        stalenessPenalty: 0,
        flags: ['manual-review'],
        appliedEntityIds: [],
        appliedRuleIds: [],
        decisions: {
          includeInContext: true,
          allowDirectAnswer: true,
          excludeFromIndex: false,
          requireManualApproval: false,
          notifyAuthor: false,
          requireSources: true,
        },
      },
    },
  ];

  beforeEach(() => {
    resetAdminStoreForTests();
    callLiteLLM.mockReset();
  });

  it('detects contradictory sources and carries trust metadata into the result', async () => {
    callLiteLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              hasConflict: true,
              confidence: 0.82,
              summary: 'VPN MFA requirements conflict.',
              conflictingSources: [
                { sourceIndex: 1, claim: 'MFA is required.' },
                { sourceIndex: 2, claim: 'VPN can be issued without MFA.' },
              ],
              recommendedSourceIndex: 1,
              lowTrustReason: 'FAQ has manual-review flag.',
            }),
          },
        },
      ],
    });

    const result = await detectConflicts('Можно ли VPN без MFA?', chunks);

    expect(result).toMatchObject({
      checked: true,
      hasConflict: true,
      lowTrust: false,
      confidence: 0.82,
      summary: 'VPN MFA requirements conflict.',
      recommendedSourceTitle: 'CorpIT:Инструкция VPN',
      metadata: {
        model: 'test-model',
        sourceCount: 2,
      },
    });
    expect(result.conflictingSources[0]).toMatchObject({
      title: 'CorpIT:Инструкция VPN',
      trustScore: 0.9,
    });
    expect(callLiteLLM).toHaveBeenCalledTimes(1);
    expect(callLiteLLM.mock.calls[0][0][0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('wiki-источники на противоречия'),
    });
    expect(callLiteLLM.mock.calls[0][0][1].content).toContain('trustScore=0.90');
  });

  it('uses the configured conflict detection system prompt', async () => {
    await setConflictDetectionConfig({
      systemPrompt: 'Custom conflict detector prompt. Return JSON only.',
    });
    callLiteLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              hasConflict: false,
              confidence: 0.95,
              summary: 'No conflict.',
              conflictingSources: [],
            }),
          },
        },
      ],
    });

    await detectConflicts('VPN?', chunks);

    expect(callLiteLLM.mock.calls[0][0][0]).toEqual({
      role: 'system',
      content: 'Custom conflict detector prompt. Return JSON only.',
    });
  });

  it('does not show a chat warning when confident detector finds no contradiction', async () => {
    callLiteLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              hasConflict: false,
              confidence: 1,
              summary: 'Sources describe different topics and do not contradict each other.',
              conflictingSources: [],
              recommendedSourceIndex: 1,
            }),
          },
        },
      ],
    });

    await expect(detectConflictsForChat('Что известно о молекулярной кухне?', chunks)).resolves.toBeNull();
    expect(callLiteLLM).toHaveBeenCalledTimes(1);
  });

  it('shows a low-trust chat warning when detector confidence is below threshold without conflict', async () => {
    callLiteLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              hasConflict: false,
              confidence: 0.42,
              summary: 'Sources are weakly related to the question.',
              conflictingSources: [],
              lowTrustReason: 'Detector confidence is low.',
            }),
          },
        },
      ],
    });

    const result = await detectConflictsForChat('VPN?', chunks);

    expect(result).toMatchObject({
      checked: true,
      hasConflict: false,
      lowTrust: true,
      confidence: 0.42,
      summary: 'Sources are weakly related to the question.',
    });
  });

  it('skips chat detection when the mode is manual', async () => {
    await setConflictDetectionConfig({ runMode: 'manual' });

    await expect(detectConflictsForChat('VPN?', chunks)).resolves.toBeNull();
    expect(callLiteLLM).not.toHaveBeenCalled();
  });

  it('returns a skipped result when there is only one source', async () => {
    const result = await detectConflicts('VPN?', chunks.slice(0, 1));

    expect(result).toMatchObject({
      checked: false,
      skippedReason: 'not_enough_sources',
      hasConflict: false,
    });
    expect(callLiteLLM).not.toHaveBeenCalled();
  });

  it('skips risk-only detection when trusted sources have no risk signal', async () => {
    const highTrustChunks = chunks.map((chunk, index) => ({
      ...chunk,
      trust: chunk.trust ? { ...chunk.trust, score: index === 0 ? 0.95 : 0.78 } : undefined,
    }));

    const result = await detectConflicts('VPN?', highTrustChunks);

    expect(result).toMatchObject({
      checked: false,
      skippedReason: 'low_risk',
    });
    expect(callLiteLLM).not.toHaveBeenCalled();
  });

  it('pairs attachment sources with parent wiki page sources', () => {
    const sources = [
      {
        sourceIndex: 1,
        pageId: 42,
        title: 'CorpCommon:Приказы/Режим рабочего времени',
        namespace: 0,
        text: 'На странице указан рабочий день до 18:00.',
        trustFlags: [],
        status: '',
      },
      {
        sourceIndex: 2,
        pageId: 42,
        title: 'CorpCommon:Приказы/Режим рабочего времени',
        namespace: 0,
        text: 'В презентации указан рабочий день до 17:00.',
        sourceType: 'attachment',
        attachmentFilename: 'Wikiai-architecture.pptx',
        attachmentMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        trustFlags: [],
        status: '',
      },
      {
        sourceIndex: 3,
        pageId: 43,
        title: 'CorpCommon:Другая страница',
        namespace: 0,
        text: 'Файл без страницы в контексте.',
        sourceType: 'attachment',
        attachmentFilename: 'orphan.docx',
        trustFlags: [],
        status: '',
      },
    ];

    expect(analyzeAttachmentParentConflicts(sources, 'risk_only')).toMatchObject({
      mode: 'risk_only',
      riskSignal: true,
      pairs: [
        {
          attachmentSourceIndex: 2,
          parentSourceIndex: 1,
          pageId: 42,
          attachmentFilename: 'Wikiai-architecture.pptx',
        },
      ],
      missingParents: [
        {
          attachmentSourceIndex: 3,
          pageId: 43,
          attachmentFilename: 'orphan.docx',
        },
      ],
    });
  });

  it('runs risk-only detection when an attachment and its parent page are both in context', async () => {
    callLiteLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              hasConflict: false,
              confidence: 0.95,
              summary: 'Attachment and parent page do not conflict.',
              conflictingSources: [],
            }),
          },
        },
      ],
    });
    const attachmentPairChunks: SearchChunk[] = [
      {
        id: 10,
        pageId: 42,
        title: 'CorpCommon:Приказы/Режим рабочего времени',
        text: 'Рабочий день заканчивается в 18:00.',
        namespace: 0,
        allowedGroups: ['ai-hr'],
        score: 0.96,
        trust: { ...chunks[0].trust!, score: 0.96 },
      },
      {
        id: 11,
        pageId: 42,
        title: 'CorpCommon:Приказы/Режим рабочего времени',
        text: 'Рабочий день заканчивается в 17:00.',
        namespace: 0,
        allowedGroups: ['ai-hr'],
        score: 0.78,
        sourceType: 'attachment',
        attachmentFilename: 'Wikiai-architecture.pptx',
        attachmentMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        trust: { ...chunks[1].trust!, score: 0.78 },
      },
    ];

    const checked = await detectConflictsWithTrace('Что сказано о режиме рабочего времени?', attachmentPairChunks);

    expect(checked.result).toMatchObject({
      checked: true,
      metadata: {
        attachmentParentConflictMode: 'risk_only',
        attachmentParentPairs: 1,
      },
    });
    expect(checked.trace.attachmentParent.pairs).toHaveLength(1);
    expect(callLiteLLM).toHaveBeenCalledTimes(1);
    const userPrompt = callLiteLLM.mock.calls[0][0][1].content;
    expect(userPrompt).toContain('Attachment-parent пары');
    expect(userPrompt).toContain('role: parent_page');
    expect(userPrompt).toContain('role: attachment');
    expect(userPrompt).toContain('attachmentFilename: Wikiai-architecture.pptx');
  });

  it('does not treat attachment-parent pairs as risk when the pair mode is disabled', async () => {
    await setConflictDetectionConfig({ attachmentParentConflictMode: 'disabled' });
    const highTrustPair = [
      {
        ...chunks[0],
        id: 20,
        pageId: 42,
        title: 'CorpCommon:Приказы/Режим рабочего времени',
        text: 'Рабочий день заканчивается в 18:00.',
        trust: { ...chunks[0].trust!, score: 0.96 },
      },
      {
        ...chunks[1],
        id: 21,
        pageId: 42,
        title: 'CorpCommon:Приказы/Режим рабочего времени',
        text: 'Рабочий день заканчивается в 17:00.',
        sourceType: 'attachment',
        attachmentFilename: 'Wikiai-architecture.pptx',
        trust: { ...chunks[1].trust!, score: 0.78 },
      },
    ];

    const result = await detectConflicts('Рабочее время?', highTrustPair);

    expect(result).toMatchObject({
      checked: false,
      skippedReason: 'low_risk',
      metadata: {
        attachmentParentConflictMode: 'disabled',
        attachmentParentPairs: 1,
      },
    });
    expect(callLiteLLM).not.toHaveBeenCalled();
  });

  it('builds default admin test data without calling LLM', () => {
    const sample = buildConflictDetectionTestData(undefined);

    expect(sample.query).toContain('VPN');
    expect(sample.chunks).toHaveLength(2);
    expect(sample.chunks[0].trust?.score).toBe(0.9);
  });

  it('builds an answer instruction for conflicting sources', () => {
    const instruction = buildConflictInstruction({
      enabled: true,
      checked: true,
      hasConflict: true,
      lowTrust: false,
      confidence: 0.82,
      summary: 'Есть конфликт.',
      recommendedSourceTitle: 'CorpIT:Инструкция VPN',
      conflictingSources: [{ title: 'CorpIT:FAQ VPN', claim: 'Можно без MFA.' }],
      metadata: {
        model: 'test-model',
        runMode: 'risk_only',
        sourceCount: 2,
      },
    });

    expect(instruction).toContain('не выдавай спорный факт как однозначный');
    expect(instruction).toContain('CorpIT:FAQ VPN');
  });

  it('builds a low-confidence instruction without saying sources conflict', () => {
    const instruction = buildConflictInstruction({
      enabled: true,
      checked: true,
      hasConflict: false,
      lowTrust: true,
      confidence: 0.4,
      summary: 'Уверенность проверки низкая.',
      conflictingSources: [],
      metadata: {
        model: 'test-model',
        runMode: 'risk_only',
        sourceCount: 2,
      },
    });

    expect(instruction).toContain('низкая уверенность проверки');
    expect(instruction).toContain('требуют проверки');
    expect(instruction).not.toContain('данные конфликтуют');
  });
});
