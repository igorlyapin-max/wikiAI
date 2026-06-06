function env(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) throw new Error(`Missing env: ${name}`);
  return value;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function optionalEnvBool(defaultValue: boolean, ...names: string[]): boolean {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return defaultValue;
}

function envInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value || !/^\d+$/.test(value)) return defaultValue;
  return Number(value);
}

function envList(name: string, defaultValue: string[]): string[] {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

export type DiagnosticLevel = 'Basic' | 'Verbose';
export type LogSink = 'stdout' | 'syslog';

export interface SyncerConfig {
  mwBaseUrl: string;
  mwApiPath: string;
  mwSyncCookie?: string;
  mwServiceUsername?: string;
  mwServicePassword?: string;
  mwServicePasswordSecret?: string;
  secretsProvider: string;
  pamBaseUrl?: string;
  pamToken?: string;
  pamTokenFile?: string;
  pamUsername?: string;
  pamPassword?: string;
  pamDefaultAccountPath?: string;
  pamPasswordEndpointPath: string;
  pamSendApplicationCredentialsInQuery: boolean;
  pamResponseType: string;
  pamValueJsonPath: string;
  pamPasswordExpirationInMinute?: string;
  pamPasswordChangeRequired?: string;
  pamComment: string;
  pamTenantId?: string;
  pamPin?: string;
  pamTimeoutMs: number;
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
  embeddingTimeoutMs: number;
  qdrantUrl: string;
  qdrantApiKey?: string;
  qdrantCollection: string;
  redisUrl: string;
  databaseUrl: string;
  gatewayBaseUrl: string;
  syncerPort: number;
  syncerAdminToken?: string;
  allowUnprotectedSyncerAdmin: boolean;
  webhookSecret?: string;
  webhookRequireSignature: boolean;
  webhookTimestampToleranceSeconds: number;
  webhookReplayTtlSeconds: number;
  chunkSize: number;
  chunkOverlap: number;
  namespaceAcl: Record<string, string[]>;
  smwSyncEnabled: boolean;
  smwSyncProperties: string[];
  cmdbDynamicPagesEnabled: boolean;
  cmdbDynamicPagesBaseUrl?: string;
  cmdbDynamicPagesMaxBlocksPerPage: number;
  cmdbDynamicPagesMaxSnapshotChars: number;
  cmdbDynamicPagesSnapshotTimeoutMs: number;
  cmdbDynamicPagesRedactParams: string[];
  nodeEnv: string;
  debugDiagnosticsEnabled: boolean;
  debugDiagnosticsLevel: DiagnosticLevel;
  logSinks: LogSink[];
  logSyslogHost: string;
  logSyslogPort: number;
  healthCheckTimeoutMs: number;
  httpBodyLimitBytes: number;
  gracefulShutdownTimeoutMs: number;
  reindexLockTtlSeconds: number;
}

export function parseDiagnosticLevel(value: string | undefined): DiagnosticLevel {
  return value?.trim().toLowerCase() === 'verbose' ? 'Verbose' : 'Basic';
}

export function parseLogSinks(value: string | undefined): LogSink[] {
  const rawSinks = value
    ? value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    : ['stdout', 'syslog'];
  const sinks = rawSinks
    .map((sink) => sink.toLowerCase())
    .filter((sink): sink is LogSink => sink === 'stdout' || sink === 'syslog');
  return sinks.length > 0 ? Array.from(new Set(sinks)) : ['stdout'];
}

const nodeEnv = env('NODE_ENV', 'development');
const syncerAdminToken = optionalEnv('SYNCER_ADMIN_TOKEN');
const allowUnprotectedSyncerAdmin = envBool('ALLOW_UNPROTECTED_SYNCER_ADMIN', nodeEnv !== 'production');
const allowSqliteInProduction = envBool('ALLOW_SQLITE_IN_PRODUCTION', false);
const databaseUrl = env(
  'DATABASE_URL',
  nodeEnv === 'production' ? undefined : 'sqlite://./state/wiki-ai.sqlite'
);

if (nodeEnv === 'production' && !syncerAdminToken) {
  throw new Error('SYNCER_ADMIN_TOKEN is required when NODE_ENV=production');
}

if (nodeEnv === 'production' && databaseUrl.startsWith('sqlite://') && !allowSqliteInProduction) {
  throw new Error('DATABASE_URL must use Postgres in production; set ALLOW_SQLITE_IN_PRODUCTION=true only for local diagnostics');
}

export const config: SyncerConfig = {
  mwBaseUrl: env('MW_BASE_URL', 'http://localhost:8082'),
  mwApiPath: env('MW_API_PATH', '/api.php'),
  mwSyncCookie: process.env.MW_SYNC_COOKIE,
  mwServiceUsername: optionalEnv('MW_SERVICE_USERNAME'),
  mwServicePassword: optionalEnv('MW_SERVICE_PASSWORD'),
  mwServicePasswordSecret: optionalEnv('MW_SERVICE_PASSWORD_SECRET'),
  secretsProvider: optionalEnv('SECRETS_PROVIDER', 'Secrets__Provider') ?? 'None',
  pamBaseUrl: optionalEnv('PAMURL', 'Secrets__IndeedPamAapm__BaseUrl'),
  pamToken: optionalEnv('PAMTOKEN', 'Secrets__IndeedPamAapm__ApplicationToken'),
  pamTokenFile: optionalEnv('PAMTOKENFILE', 'Secrets__IndeedPamAapm__ApplicationTokenFile'),
  pamUsername: optionalEnv('PAMUSERNAME', 'Secrets__IndeedPamAapm__ApplicationUsername'),
  pamPassword: optionalEnv('PAMPASSWORD', 'Secrets__IndeedPamAapm__ApplicationPassword'),
  pamDefaultAccountPath: optionalEnv('PAMDEFAULTACCOUNTPATH', 'Secrets__IndeedPamAapm__DefaultAccountPath'),
  pamPasswordEndpointPath: optionalEnv('PAMPASSWORDENDPOINTPATH', 'Secrets__IndeedPamAapm__PasswordEndpointPath')
    ?? '/sc_aapm_ui/rest/aapm/password',
  pamSendApplicationCredentialsInQuery: optionalEnvBool(
    false,
    'PAM_SEND_APPLICATION_CREDENTIALS_IN_QUERY',
    'PAMSENDAPPLICATIONCREDENTIALSINQUERY',
    'Secrets__IndeedPamAapm__SendApplicationCredentialsInQuery'
  ),
  pamResponseType: optionalEnv('PAMRESPONSETYPE', 'Secrets__IndeedPamAapm__ResponseType') ?? 'json',
  pamValueJsonPath: optionalEnv('PAMVALUEJSONPATH', 'Secrets__IndeedPamAapm__ValueJsonPath') ?? 'password',
  pamPasswordExpirationInMinute: optionalEnv(
    'PAMPASSWORDEXPIRATIONINMINUTE',
    'Secrets__IndeedPamAapm__PasswordExpirationInMinute'
  ),
  pamPasswordChangeRequired: optionalEnv(
    'PAMPASSWORDCHANGEREQUIRED',
    'Secrets__IndeedPamAapm__PasswordChangeRequired'
  ),
  pamComment: optionalEnv('PAMCOMMENT', 'Secrets__IndeedPamAapm__Comment') ?? 'wikiai {service} {secretId}',
  pamTenantId: optionalEnv('PAMTENANTID', 'Secrets__IndeedPamAapm__TenantId'),
  pamPin: optionalEnv('PAMPIN', 'Secrets__IndeedPamAapm__Pin'),
  pamTimeoutMs: parseInt(optionalEnv('PAMTIMEOUTMS', 'Secrets__IndeedPamAapm__TimeoutMs') ?? '10000', 10),
  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://localhost:11434'),
  ollamaEmbeddingModel: env('OLLAMA_EMBEDDING_MODEL', 'nomic-embed-text'),
  embeddingTimeoutMs: envInt('EMBEDDING_TIMEOUT_MS', 15_000),
  qdrantUrl: env('QDRANT_URL', 'http://localhost:6333'),
  qdrantApiKey: optionalEnv('QDRANT_API_KEY'),
  qdrantCollection: env('QDRANT_COLLECTION', 'wiki_chunks'),
  redisUrl: env('REDIS_URL', 'redis://localhost:16379/0'),
  databaseUrl,
  gatewayBaseUrl: env('GATEWAY_BASE_URL', 'http://localhost:3000'),
  syncerPort: parseInt(env('SYNCER_PORT', '3001'), 10),
  syncerAdminToken,
  allowUnprotectedSyncerAdmin,
  webhookSecret: optionalEnv('WIKIAI_WEBHOOK_SECRET', 'WEBHOOK_SECRET'),
  webhookRequireSignature: envBool('WIKIAI_WEBHOOK_REQUIRE_SIGNATURE', nodeEnv === 'production'),
  webhookTimestampToleranceSeconds: envInt('WIKIAI_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', 300),
  webhookReplayTtlSeconds: envInt('WIKIAI_WEBHOOK_REPLAY_TTL_SECONDS', 900),
  chunkSize: parseInt(env('CHUNK_SIZE', '512'), 10),
  chunkOverlap: parseInt(env('CHUNK_OVERLAP', '50'), 10),
  // Namespace ID → allowed_groups mapping
  namespaceAcl: JSON.parse(env('NAMESPACE_ACL', '{"0":["*"]}')) as Record<string, string[]>,
  smwSyncEnabled: envBool('SMW_SYNC_ENABLED', true),
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
  cmdbDynamicPagesEnabled: envBool('CMDBDYNAMICPAGES_ENABLED', false),
  cmdbDynamicPagesBaseUrl: optionalEnv('CMDBDYNAMICPAGES_BASE_URL'),
  cmdbDynamicPagesMaxBlocksPerPage: parseInt(env('CMDBDYNAMICPAGES_MAX_BLOCKS_PER_PAGE', '10'), 10),
  cmdbDynamicPagesMaxSnapshotChars: parseInt(env('CMDBDYNAMICPAGES_MAX_SNAPSHOT_CHARS', '20000'), 10),
  cmdbDynamicPagesSnapshotTimeoutMs: parseInt(env('CMDBDYNAMICPAGES_SNAPSHOT_TIMEOUT_MS', '10000'), 10),
  cmdbDynamicPagesRedactParams: envList('CMDBDYNAMICPAGES_REDACT_PARAMS', [
    'password',
    'passwd',
    'pwd',
    'token',
    'secret',
    'authorization',
    'auth',
    'csrf',
  ]),
  nodeEnv,
  debugDiagnosticsEnabled: envBool('DEBUG_DIAGNOSTICS_ENABLED', false),
  debugDiagnosticsLevel: parseDiagnosticLevel(process.env.DEBUG_DIAGNOSTICS_LEVEL),
  logSinks: parseLogSinks(process.env.LOG_SINKS),
  logSyslogHost: env('LOG_SYSLOG_HOST', '127.0.0.1'),
  logSyslogPort: parseInt(env('LOG_SYSLOG_PORT', '514'), 10),
  healthCheckTimeoutMs: parseInt(env('HEALTH_CHECK_TIMEOUT_MS', '2000'), 10),
  httpBodyLimitBytes: envInt('HTTP_BODY_LIMIT_BYTES', 1_048_576),
  gracefulShutdownTimeoutMs: envInt('GRACEFUL_SHUTDOWN_TIMEOUT_MS', 10_000),
  reindexLockTtlSeconds: envInt('REINDEX_LOCK_TTL_SECONDS', 3600),
};
