import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import { getSecretStatus, resolveSecretValue } from '../secrets.js';

const originalConfig = { ...config };

function restoreConfig(): void {
  Object.assign(config, originalConfig);
}

afterEach(() => {
  restoreConfig();
  vi.unstubAllGlobals();
});

describe('secret resolver', () => {
  it('returns direct values without treating them as secret references', async () => {
    await expect(resolveSecretValue('direct-password')).resolves.toBe('direct-password');
    expect(getSecretStatus('direct-password')).toEqual({
      configured: true,
      usesSecretReference: false,
      provider: 'None',
    });
  });

  it('treats companion secret names as secret references and resolves them through Indeed PAM AAPM', async () => {
    config.secretsProvider = 'IndeedPamAapm';
    config.pamBaseUrl = 'https://pam.example.local';
    config.pamToken = 'application-token';
    config.pamDefaultAccountPath = 'Vault/MediaWiki';
    config.pamResponseType = 'json';
    config.pamValueJsonPath = 'password';
    config.pamComment = 'wikiai {service} {secretId}';

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/sc_aapm_ui/rest/aapm/password');
      expect(url.searchParams.get('token')).toBe('application-token');
      expect(url.searchParams.get('sapmaccountpath')).toBe('Vault/MediaWiki');
      expect(url.searchParams.get('sapmaccountname')).toBe('wikiai-syncer');
      expect(url.searchParams.get('comment')).toBe('wikiai wikiai-syncer wikiai-syncer');
      return new Response(JSON.stringify({ password: 'resolved-password' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveSecretValue(undefined, 'wikiai-syncer')).resolves.toBe('resolved-password');
    expect(getSecretStatus(undefined, 'wikiai-syncer')).toMatchObject({
      configured: true,
      usesSecretReference: true,
      provider: 'IndeedPamAapm',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects secret references when no provider is configured', async () => {
    config.secretsProvider = 'None';
    config.pamBaseUrl = undefined;
    config.pamToken = undefined;
    config.pamUsername = undefined;
    config.pamPassword = undefined;

    await expect(resolveSecretValue('secret://Vault/MediaWiki/wikiai-syncer'))
      .rejects.toThrow("secret provider is 'None'");
  });
});
