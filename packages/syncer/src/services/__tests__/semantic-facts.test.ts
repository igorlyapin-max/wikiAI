import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPageContent, fetchSemanticFacts, normalizeSemanticPrintouts, semanticFactsToText } from '../mediawiki.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('semantic facts', () => {
  it('normalizes SMW ask printouts into string arrays', () => {
    expect(normalizeSemanticPrintouts({
      Департамент: ['Департамент персонала'],
      'Дата действия': [{ timestamp: '2026-05-31' }],
      Страница: [{ fulltext: 'CorpCommon:Документ' }],
      Пусто: [],
    })).toEqual({
      Департамент: ['Департамент персонала'],
      'Дата действия': ['2026-05-31'],
      Страница: ['CorpCommon:Документ'],
    });
  });

  it('renders semantic facts as indexable text', () => {
    expect(semanticFactsToText({
      Департамент: ['ИТ департамент'],
      Критичность: ['Критичная'],
    })).toContain('Департамент: ИТ департамент');
  });

  it('reads page content together with the latest revision timestamp', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('rvprop')).toBe('content|timestamp');
      return new Response(JSON.stringify({
        query: {
          pages: {
            10: {
              pageid: 10,
              ns: 0,
              title: 'Main Page',
              revisions: [{
                timestamp: '2024-01-15T10:00:00Z',
                slots: {
                  main: {
                    '*': 'Page body',
                  },
                },
              }],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPageContent('Main Page')).resolves.toEqual({
      pageid: 10,
      ns: 0,
      title: 'Main Page',
      content: 'Page body',
      lastModified: '2024-01-15T10:00:00Z',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit property list for SMW ask queries', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('query')).toBe(
        '[[CorpIT:VPN]]|?Департамент|?Тип документа|limit=1'
      );
      return new Response(JSON.stringify({
        query: {
          results: {
            'CorpIT:VPN': {
              printouts: {
                Департамент: ['ИТ'],
              },
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSemanticFacts('CorpIT:VPN', ['Департамент', 'Тип документа'])).resolves.toEqual({
      Департамент: ['ИТ'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips SMW ask when the explicit property list is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSemanticFacts('CorpIT:VPN', [])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
