import { AppConfig } from './types/index.js';

function env(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function envList(name: string, defaultValue: string[]): string[] {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function envBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value || !/^\d+$/.test(value)) return defaultValue;
  return Number(value);
}

function envFloat(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function envExternalAclMode(value: string | undefined): AppConfig['externalAclMode'] {
  return value === 'groups_only' ? 'groups_only' : 'mediawiki_check';
}

export function parseDiagnosticLevel(value: string | undefined): AppConfig['debugDiagnosticsLevel'] {
  return value?.trim().toLowerCase() === 'verbose' ? 'Verbose' : 'Basic';
}

export function parseLogSinks(value: string | undefined): AppConfig['logSinks'] {
  const rawSinks = value
    ? value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    : ['stdout', 'syslog'];
  const sinks = rawSinks
    .map((sink) => sink.toLowerCase())
    .filter((sink): sink is 'stdout' | 'syslog' => sink === 'stdout' || sink === 'syslog');
  return sinks.length > 0 ? Array.from(new Set(sinks)) : ['stdout'];
}

export function parseCorsOrigins(value: string | undefined, nodeEnv: string): string[] {
  const explicitOrigins = value
    ?.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (explicitOrigins && explicitOrigins.length > 0) {
    return Array.from(new Set(explicitOrigins));
  }

  if (nodeEnv === 'production') {
    return [];
  }

  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8082',
    'http://127.0.0.1:8082',
  ];
}

const nodeEnv = env('NODE_ENV', 'development');

export const DEFAULT_OPENSEARCH_BASE_URL = 'http://opensearch:9200';

export const config: AppConfig = {
  mwBaseUrl: env('MW_BASE_URL', 'http://localhost:8082'),
  mwPublicBaseUrl: process.env.MW_PUBLIC_BASE_URL ?? '',
  mwApiPath: env('MW_API_PATH', '/api.php'),
  litellmBaseUrl: env('LITELLM_BASE_URL'),
  litellmApiKey: env('LITELLM_API_KEY'),
  litellmModel: env('LITELLM_MODEL', 'mistral-7b-instruct'),
  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://localhost:11434'),
  ollamaEmbeddingModel: env('OLLAMA_EMBEDDING_MODEL', 'nomic-embed-text'),
  colbertBaseUrl: process.env.COLBERT_BASE_URL ?? '',
  colbertModel: env('COLBERT_MODEL', 'antoinelouis/colbert-xm'),
  colbertCollection: env('COLBERT_COLLECTION', 'wiki_colbert_chunks'),
  opensearchEnabled: envBoolean('OPENSEARCH_ENABLED', false),
  opensearchBaseUrl: env('OPENSEARCH_BASE_URL', DEFAULT_OPENSEARCH_BASE_URL),
  opensearchIndexName: env('OPENSEARCH_INDEX_NAME', 'wikiai_chunks'),
  opensearchUsername: process.env.OPENSEARCH_USERNAME ?? '',
  opensearchPassword: process.env.OPENSEARCH_PASSWORD ?? '',
  opensearchApiKey: process.env.OPENSEARCH_API_KEY ?? '',
  opensearchTimeoutMs: envInt('OPENSEARCH_TIMEOUT_MS', 5000),
  opensearchTlsRejectUnauthorized: envBoolean('OPENSEARCH_TLS_REJECT_UNAUTHORIZED', true),
  opensearchAnalyzer: env('OPENSEARCH_ANALYZER', 'russian'),
  opensearchFuzzyEnabled: envBoolean('OPENSEARCH_FUZZY_ENABLED', true),
  opensearchHighlightEnabled: envBoolean('OPENSEARCH_HIGHLIGHT_ENABLED', true),
  opensearchTitleBoost: envFloat('OPENSEARCH_TITLE_BOOST', 2.0),
  opensearchTextBoost: envFloat('OPENSEARCH_TEXT_BOOST', 1.0),
  opensearchCandidateLimit: envInt('OPENSEARCH_CANDIDATE_LIMIT', 50),
  qdrantUrl: env('QDRANT_URL', 'http://localhost:6333'),
  qdrantCollection: env('QDRANT_COLLECTION', 'wiki_chunks'),
  redisUrl: env('REDIS_URL', 'redis://localhost:16379/0'),
  databaseUrl: env('DATABASE_URL', 'sqlite://./state/wiki-ai.sqlite'),
  syncerBaseUrl: env('SYNCER_BASE_URL', 'http://localhost:3001'),
  syncerAdminToken: process.env.SYNCER_ADMIN_TOKEN,
  smwSyncProperties: envList('SMW_SYNC_PROPERTIES', [
    'Департамент',
    'Отдел',
    'Тип документа',
    'Владелец процесса',
    'Статус документа',
    'Система',
    'Процесс',
    'Дата действия',
    'Критичность',
  ]),
  gatewayPort: parseInt(env('GATEWAY_PORT', '3000'), 10),
  nodeEnv,
  userGroupsCacheTtl: parseInt(env('USER_GROUPS_CACHE_TTL', '300'), 10),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS, nodeEnv),
  externalApiEnabled: envBoolean('EXTERNAL_API_ENABLED', false),
  externalMcpEnabled: envBoolean('EXTERNAL_MCP_ENABLED', false),
  externalAnonymousSearchAllowed: envBoolean('EXTERNAL_ANONYMOUS_SEARCH_ALLOWED', true),
  externalMaxTopK: envInt('EXTERNAL_MAX_TOP_K', 10),
  externalAclMode: envExternalAclMode(process.env.EXTERNAL_ACL_MODE),
  oidcIssuer: process.env.OIDC_ISSUER ?? '',
  oidcAudience: process.env.OIDC_AUDIENCE ?? '',
  oidcJwksUrl: process.env.OIDC_JWKS_URL ?? '',
  oidcSubjectClaim: process.env.OIDC_SUBJECT_CLAIM ?? 'sub',
  oidcUsernameClaim: process.env.OIDC_USERNAME_CLAIM ?? 'preferred_username',
  oidcGroupsClaim: process.env.OIDC_GROUPS_CLAIM ?? 'groups',
  debugDiagnosticsEnabled: envBoolean('DEBUG_DIAGNOSTICS_ENABLED', false),
  debugDiagnosticsLevel: parseDiagnosticLevel(process.env.DEBUG_DIAGNOSTICS_LEVEL),
  logSinks: parseLogSinks(process.env.LOG_SINKS),
  logSyslogHost: env('LOG_SYSLOG_HOST', '127.0.0.1'),
  logSyslogPort: envInt('LOG_SYSLOG_PORT', 514),
  healthCheckTimeoutMs: envInt('HEALTH_CHECK_TIMEOUT_MS', 2000),
};
