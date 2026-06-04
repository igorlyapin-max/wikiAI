import { useEffect, useMemo, useState } from 'react';
import { ApiRequestError, fetchJson } from './api';

interface AdminPageProps {
  apiBase: string;
}

interface HealthCheck {
  status: string;
  latencyMs?: number;
  error?: string;
}

interface HealthStatus {
  status: string;
  checks?: Record<string, HealthCheck>;
}

interface SearchIndexStatus {
  values?: {
    pages?: number;
    chunks?: number;
    ftsChunks?: number;
    readiness?: {
      status?: string;
      reasons?: string[];
    };
  };
}

interface ServiceConfigStatus {
  values?: {
    gateway?: {
      baseUrl?: string;
    };
    syncer?: {
      baseUrl?: string;
    };
  };
}

type PanelState<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string; httpStatus?: number };

interface AdminOverview {
  health: PanelState<HealthStatus>;
  searchIndex: PanelState<SearchIndexStatus>;
  serviceConfig: PanelState<ServiceConfigStatus>;
}

async function loadPanel<T>(apiBase: string, path: string): Promise<PanelState<T>> {
  try {
    return { status: 'ready', value: await fetchJson<T>(apiBase, path) };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error && error.message ? error.message : 'Ошибка загрузки данных',
      httpStatus: error instanceof ApiRequestError ? error.status : undefined,
    };
  }
}

export async function loadAdminOverview(apiBase: string): Promise<AdminOverview> {
  const [health, searchIndex, serviceConfig] = await Promise.all([
    loadPanel<HealthStatus>(apiBase, '/api/admin/health'),
    loadPanel<SearchIndexStatus>(apiBase, '/api/admin/search-index/status'),
    loadPanel<ServiceConfigStatus>(apiBase, '/api/admin/service-config'),
  ]);

  return { health, searchIndex, serviceConfig };
}

function statusClass(status: string | undefined): string {
  if (status === 'healthy' || status === 'ready' || status === 'ok') return 'status status-ok';
  if (status === 'degraded' || status === 'warning') return 'status status-warning';
  if (status === 'error' || status === 'blocked') return 'status status-danger';
  return 'status';
}

function ErrorState({ state }: { state: Extract<PanelState<unknown>, { status: 'error' }> }) {
  return (
    <div className="callout callout-danger" role="alert">
      {state.httpStatus === 403 ? 'Недостаточно прав: требуется sysop или aiadmin.' : state.message}
    </div>
  );
}

function HealthPanel({ state }: { state: PanelState<HealthStatus> }) {
  if (state.status === 'loading') return <div className="skeleton">Загрузка...</div>;
  if (state.status === 'error') return <ErrorState state={state} />;

  const checks = Object.entries(state.value.checks ?? {});
  return (
    <>
      <div className={statusClass(state.value.status)}>{state.value.status}</div>
      <div className="metric-grid">
        {checks.map(([name, check]) => (
          <div className="metric" key={name}>
            <span>{name}</span>
            <strong>{check.status}</strong>
            {typeof check.latencyMs === 'number' && <small>{check.latencyMs} ms</small>}
            {check.error && <small className="danger-text">{check.error}</small>}
          </div>
        ))}
      </div>
    </>
  );
}

function SearchIndexPanel({ state }: { state: PanelState<SearchIndexStatus> }) {
  if (state.status === 'loading') return <div className="skeleton">Загрузка...</div>;
  if (state.status === 'error') return <ErrorState state={state} />;

  const values = state.value.values ?? {};
  const readiness = values.readiness;
  return (
    <>
      <div className={statusClass(readiness?.status)}>{readiness?.status ?? 'unknown'}</div>
      <div className="metric-grid">
        <div className="metric">
          <span>pages</span>
          <strong>{values.pages ?? 0}</strong>
        </div>
        <div className="metric">
          <span>chunks</span>
          <strong>{values.chunks ?? 0}</strong>
        </div>
        <div className="metric">
          <span>bm25</span>
          <strong>{values.ftsChunks ?? 0}</strong>
        </div>
      </div>
      {readiness?.reasons && readiness.reasons.length > 0 && (
        <ul className="compact-list">
          {readiness.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function ServiceConfigPanel({ state }: { state: PanelState<ServiceConfigStatus> }) {
  if (state.status === 'loading') return <div className="skeleton">Загрузка...</div>;
  if (state.status === 'error') return <ErrorState state={state} />;

  const values = state.value.values;
  return (
    <div className="metric-grid">
      <div className="metric metric-wide">
        <span>gateway</span>
        <strong>{values?.gateway?.baseUrl ?? 'same-origin /api'}</strong>
      </div>
      <div className="metric metric-wide">
        <span>syncer</span>
        <strong>{values?.syncer?.baseUrl ?? 'not configured'}</strong>
      </div>
    </div>
  );
}

export default function AdminPage({ apiBase }: AdminPageProps) {
  const [overview, setOverview] = useState<AdminOverview>({
    health: { status: 'loading' },
    searchIndex: { status: 'loading' },
    serviceConfig: { status: 'loading' },
  });
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      setOverview(await loadAdminOverview(apiBase));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [apiBase]);

  const hasAccessError = useMemo(
    () => Object.values(overview).some((state) => state.status === 'error' && state.httpStatus === 403),
    [overview]
  );

  return (
    <section className="page-panel" aria-labelledby="admin-title">
      <div className="page-heading">
        <div>
          <h1 id="admin-title">Администрирование WikiAI</h1>
          <p>Gateway, индекс и сервисные подключения</p>
        </div>
        <div className="toolbar">
          <button className="button" type="button" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? 'Обновление...' : 'Обновить'}
          </button>
          <a className="button button-secondary" href="/wiki/Special:AIAdmin">
            Special:AIAdmin
          </a>
        </div>
      </div>

      {hasAccessError && (
        <div className="callout callout-warning" role="status">
          Доступ проверяется Gateway по MediaWiki сессии.
        </div>
      )}

      <div className="dashboard-grid">
        <article className="dashboard-card">
          <h2>Gateway health</h2>
          <HealthPanel state={overview.health} />
        </article>
        <article className="dashboard-card">
          <h2>Search index</h2>
          <SearchIndexPanel state={overview.searchIndex} />
        </article>
        <article className="dashboard-card">
          <h2>Service config</h2>
          <ServiceConfigPanel state={overview.serviceConfig} />
        </article>
      </div>
    </section>
  );
}
