import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractCmdbDynamicSources,
  fetchCmdbDynamicSnapshotChunk,
} from '../cmdbdynamicpages.js';

describe('cmdbdynamicpages integration helpers', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts parser-function markers from wikitext and resolves simple page magic words', () => {
    const sources = extractCmdbDynamicSources(
      '{{#cmdb: |template=AssetsByOwner |owner={{PAGENAME}} |mode=widget }}',
      'CorpIT:Router42'
    );

    expect(sources).toEqual([
      expect.objectContaining({
        markerType: 'parser_function',
        templateCode: 'AssetsByOwner',
        params: { owner: 'Router42' },
        mode: 'widget',
        allowAnonymousSnapshot: true,
      }),
    ]);
  });

  it('extracts HTML markers for future rendered-output indexing', () => {
    const sources = extractCmdbDynamicSources(
      '<div data-wikiai-dynamic-source="cmdbdynamicpages" data-template-code="Assets" data-params=\'{"city":"city49"}\'></div>'
    );

    expect(sources).toEqual([
      expect.objectContaining({
        markerType: 'html_marker',
        templateCode: 'Assets',
        params: { city: 'city49' },
      }),
    ]);
  });

  it('does not call anonymous runtime when parameters still contain unresolved wikitext', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const source = extractCmdbDynamicSources('{{#cmdb: |template=Assets |owner={{#property:Owner}} }}')[0];

    const chunk = await fetchCmdbDynamicSnapshotChunk(source, {
      enabled: true,
      baseUrl: 'http://cmdbdynamicpages.local',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunk).toMatchObject({
      status: 'unresolved_params',
      snapshotFound: false,
    });
  });

  it('converts published static snapshots to indexable text without sending cookies', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        snapshotFound: true,
        template: { code: 'Assets', description: 'Assets by city' },
        tables: [{
          name: 'assets',
          title: 'Assets',
          columns: [{ key: 'Code', label: 'Code' }],
          rows: [{ Code: 'srv-01' }],
        }],
        cache: {
          paramsHash: 'params-hash',
          publishedBy: 'admin',
          publishedAt: '2026-06-04T10:00:00Z',
          specHash: 'spec-hash',
        },
      }),
      init,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const source = extractCmdbDynamicSources('{{#cmdb: |template=Assets |city=city49 |token=secret }}')[0];

    const chunk = await fetchCmdbDynamicSnapshotChunk(source, {
      enabled: true,
      baseUrl: 'http://cmdbdynamicpages.local',
      redactParams: ['token'],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://cmdbdynamicpages.local/cmdbuild/dynamicpages/ui/run/Assets?city=city49&token=secret&json=true',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Cookie: expect.any(String) }),
      })
    );
    expect(chunk).toMatchObject({
      status: 'snapshot_hit',
      snapshotFound: true,
      paramsHash: 'params-hash',
      publishedBy: 'admin',
      publishedAt: '2026-06-04T10:00:00Z',
      specHash: 'spec-hash',
    });
    expect(chunk?.text).toContain('srv-01');
    expect(chunk?.text).toContain('"token":"[redacted]"');
  });
});
