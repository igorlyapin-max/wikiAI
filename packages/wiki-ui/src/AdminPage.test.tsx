import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import AdminPage, { loadAdminOverview } from './AdminPage';

let fetchMock: MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

describe('AdminPage', () => {
  it('loads the same-origin admin overview', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/admin/health')) {
        return jsonResponse({
          status: 'healthy',
          checks: {
            qdrant: { status: 'ok', latencyMs: 7 },
            redis: { status: 'ok', latencyMs: 4 },
          },
        });
      }
      if (url.endsWith('/api/admin/search-index/status')) {
        return jsonResponse({
          values: {
            pages: 42,
            chunks: 120,
            ftsChunks: 118,
            readiness: { status: 'ready' },
          },
        });
      }
      return jsonResponse({
        values: {
          gateway: { baseUrl: 'http://gateway:3000' },
          syncer: { baseUrl: 'http://syncer:3001' },
        },
      });
    });

    render(<AdminPage apiBase="" />);

    expect(await screen.findByText('healthy')).toBeInTheDocument();
    expect(screen.getByText('qdrant')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('http://syncer:3001')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/health', { credentials: 'include' });
  });

  it('keeps gateway authorization errors visible', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Requires sysop or aiadmin group' }, 403));

    render(<AdminPage apiBase="" />);

    await waitFor(() => {
      expect(screen.getAllByText('Недостаточно прав: требуется sysop или aiadmin.')).toHaveLength(3);
    });
    expect(screen.getByText('Доступ проверяется Gateway по MediaWiki сессии.')).toBeInTheDocument();
  });

  it('supports a configured API base for local preview', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'healthy' }));

    await loadAdminOverview('http://127.0.0.1:3000');

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3000/api/admin/health', { credentials: 'include' });
  });
});
