function env(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) throw new Error(`Missing env: ${name}`);
  return value;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function optionalEnvBool(defaultValue: boolean, ...names: string[]): boolean {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return defaultValue;
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

export const config = {
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
  qdrantUrl: env('QDRANT_URL', 'http://localhost:6333'),
  qdrantCollection: env('QDRANT_COLLECTION', 'wiki_chunks'),
  redisUrl: env('REDIS_URL', 'redis://localhost:16379/0'),
  databaseUrl: env('DATABASE_URL', 'sqlite://./state/wiki-ai.sqlite'),
  gatewayBaseUrl: env('GATEWAY_BASE_URL', 'http://localhost:3000'),
  syncerPort: parseInt(env('SYNCER_PORT', '3001'), 10),
  syncerAdminToken: process.env.SYNCER_ADMIN_TOKEN,
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
};
