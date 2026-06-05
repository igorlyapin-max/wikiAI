import { describe, expect, it } from 'vitest';
import { formatChunksForPrompt } from '../prompt-context.js';
import { SearchChunk } from '../../types/index.js';

describe('prompt context formatting', () => {
  it('adds semantic facts as a structured document block', () => {
    const chunks: SearchChunk[] = [
      {
        id: 1,
        pageId: 101,
        title: 'CorpIT:Инструкция VPN',
        text: 'Основной текст инструкции.',
        namespace: 3030,
        allowedGroups: ['ai-it', 'ai-exec'],
        score: 0.91,
        semanticFacts: {
          'Тип документа': ['Инструкция'],
          'Департамент': ['ИТ департамент'],
          'Критичность': ['Высокая'],
        },
      },
    ];

    expect(formatChunksForPrompt(chunks)).toBe(
      [
        '[1] CorpIT:Инструкция VPN',
        'Свойства документа:',
        'Департамент: ИТ департамент',
        'Критичность: Высокая',
        'Тип документа: Инструкция',
        '',
        'Основной текст инструкции.',
      ].join('\n')
    );
  });

  it('keeps the previous compact format when semantic facts are absent', () => {
    const chunks: SearchChunk[] = [
      {
        id: 2,
        pageId: 102,
        title: 'Public',
        text: 'Открытый текст.',
        namespace: 0,
        allowedGroups: ['*'],
        score: 0.8,
      },
    ];

    expect(formatChunksForPrompt(chunks)).toBe('[1] Public\n\nОткрытый текст.');
  });

  it('limits the formatted context by max chars without changing source numbering', () => {
    const chunks: SearchChunk[] = [
      {
        id: 2,
        pageId: 102,
        title: 'Public',
        text: 'Открытый текст документа с подробным продолжением.',
        namespace: 0,
        allowedGroups: ['*'],
        score: 0.8,
      },
    ];

    const context = formatChunksForPrompt(chunks, { maxChars: 32 });

    expect(context.length).toBeLessThanOrEqual(32);
    expect(context).toMatch(/^\[1\] Public\n\nОткрытый/);
    expect(context).toMatch(/\.\.\.$/);
  });

  it('adds trust metadata when it is available', () => {
    const chunks: SearchChunk[] = [
      {
        id: 3,
        pageId: 103,
        title: 'CorpIT:Регламент VPN',
        text: 'Текст регламента.',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.92,
        trust: {
          modelId: 'corp-default',
          score: 0.83,
          lastModified: '2026-01-10T09:00:00Z',
          stalenessPenalty: 0,
          flags: ['official', 'verified'],
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

    expect(formatChunksForPrompt(chunks)).toBe(
      [
        '[1] CorpIT:Регламент VPN',
        'Доверие источника:',
        'score: 0.83',
        'flags: official, verified',
        'lastModified: 2026-01-10T09:00:00Z',
        'includeInContext: true',
        'allowDirectAnswer: true',
        '',
        'Текст регламента.',
      ].join('\n')
    );
  });
});
