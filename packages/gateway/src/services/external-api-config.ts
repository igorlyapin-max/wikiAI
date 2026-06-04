import { z } from 'zod';
import { config } from '../config.js';
import { getAdminStore } from '../db/admin-store.js';

const CONFIG_AREA = 'external-api-config';
const CONFIG_KEY = 'default';

export type ExternalAclMode = 'mediawiki_check' | 'groups_only';

export interface ExternalApiConfig {
  enabled: boolean;
  mcpEnabled: boolean;
  anonymousSearchAllowed: boolean;
  maxTopK: number;
  defaultRetrievalProfileId: string;
  aclMode: ExternalAclMode;
  oidc: {
    issuer: string;
    audience: string;
    jwksUrl: string;
    subjectClaim: string;
    usernameClaim: string;
    groupsClaim: string;
  };
}

export interface ExternalApiCapabilities {
  searchEnabled: boolean;
  chatEnabled: boolean;
  mcpEnabled: boolean;
  authModes: Array<'cookie' | 'oidc'>;
  maxTopK: number;
  streamingSupported: boolean;
  anonymousSearchAllowed: boolean;
  aclMode: ExternalAclMode;
  defaultRetrievalProfileId?: string;
  oidcConfigured: boolean;
  warnings: string[];
}

const configSchema = z.object({
  enabled: z.boolean().optional(),
  mcpEnabled: z.boolean().optional(),
  anonymousSearchAllowed: z.boolean().optional(),
  maxTopK: z.number().int().min(1).max(50).optional(),
  defaultRetrievalProfileId: z.string().trim().max(120).regex(/^[A-Za-z0-9_.-]+$/).or(z.literal('')).optional(),
  aclMode: z.enum(['mediawiki_check', 'groups_only']).optional(),
  oidc: z.object({
    issuer: z.string().trim().max(500).optional(),
    audience: z.string().trim().max(500).optional(),
    jwksUrl: z.string().trim().max(500).optional(),
    subjectClaim: z.string().trim().min(1).max(120).optional(),
    usernameClaim: z.string().trim().min(1).max(120).optional(),
    groupsClaim: z.string().trim().min(1).max(120).optional(),
  }).strict().optional(),
}).strict();

export const DEFAULT_EXTERNAL_API_CONFIG: ExternalApiConfig = {
  enabled: config.externalApiEnabled,
  mcpEnabled: config.externalMcpEnabled,
  anonymousSearchAllowed: config.externalAnonymousSearchAllowed,
  maxTopK: Math.max(1, Math.min(config.externalMaxTopK, 50)),
  defaultRetrievalProfileId: '',
  aclMode: config.externalAclMode,
  oidc: {
    issuer: config.oidcIssuer,
    audience: config.oidcAudience,
    jwksUrl: config.oidcJwksUrl,
    subjectClaim: config.oidcSubjectClaim,
    usernameClaim: config.oidcUsernameClaim,
    groupsClaim: config.oidcGroupsClaim,
  },
};

function mergeExternalApiConfig(
  base: ExternalApiConfig,
  patch: Partial<ExternalApiConfig>
): ExternalApiConfig {
  return {
    ...base,
    ...patch,
    oidc: {
      ...base.oidc,
      ...(patch.oidc ?? {}),
    },
  };
}

export async function getExternalApiConfig(): Promise<ExternalApiConfig> {
  const stored = await getAdminStore().getJson<Partial<ExternalApiConfig>>(CONFIG_AREA, CONFIG_KEY);
  return mergeExternalApiConfig(DEFAULT_EXTERNAL_API_CONFIG, stored ?? {});
}

export async function setExternalApiConfig(input: unknown, actor?: string): Promise<ExternalApiConfig> {
  const parsed = configSchema.parse(input);
  const current = await getExternalApiConfig();
  const updated = mergeExternalApiConfig(current, parsed as Partial<ExternalApiConfig>);
  await getAdminStore().setJson(CONFIG_AREA, CONFIG_KEY, updated, {
    actor,
    action: 'external-api.config.update',
    entityType: 'external-api',
  });
  return updated;
}

export function externalOidcConfigured(configValue: ExternalApiConfig): boolean {
  return Boolean(configValue.oidc.issuer && configValue.oidc.audience && configValue.oidc.jwksUrl);
}

export function toExternalApiCapabilities(configValue: ExternalApiConfig): ExternalApiCapabilities {
  const oidcConfigured = externalOidcConfigured(configValue);
  const warnings: string[] = [];
  if (configValue.aclMode === 'groups_only') {
    warnings.push('OIDC ACL uses indexed allowed_groups without MediaWiki readable post-check');
  }
  if (configValue.enabled && !oidcConfigured) {
    warnings.push('OIDC is not fully configured; external Bearer auth will be rejected, cookie auth remains available');
  }

  return {
    searchEnabled: configValue.enabled,
    chatEnabled: configValue.enabled,
    mcpEnabled: configValue.enabled && configValue.mcpEnabled,
    authModes: oidcConfigured ? ['cookie', 'oidc'] : ['cookie'],
    maxTopK: configValue.maxTopK,
    streamingSupported: true,
    anonymousSearchAllowed: configValue.anonymousSearchAllowed,
    aclMode: configValue.aclMode,
    defaultRetrievalProfileId: configValue.defaultRetrievalProfileId || undefined,
    oidcConfigured,
    warnings,
  };
}
