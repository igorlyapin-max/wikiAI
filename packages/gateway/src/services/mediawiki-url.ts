import { config } from '../config.js';

export interface WikiPageUrlOptions {
  baseUrl?: string;
  requestOrigin?: unknown;
  requestHost?: unknown;
  requestProtocol?: unknown;
}

function encodeWikiTitlePath(title: string): string {
  return title
    .trim()
    .replace(/ /g, '_')
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/%3A/gi, ':'))
    .join('/');
}

function readHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString().replace(/\/+$/, '')
      : undefined;
  } catch {
    return undefined;
  }
}

function readHostBaseUrl(host: unknown, protocol: unknown): string | undefined {
  if (typeof host !== 'string' || !host.trim()) return undefined;
  const scheme = typeof protocol === 'string' && protocol.toLowerCase() === 'https' ? 'https' : 'http';
  return `${scheme}://${host.trim().replace(/\/+$/, '')}`;
}

export function resolveWikiPublicBaseUrl(options: WikiPageUrlOptions = {}): string {
  return readHttpUrl(options.baseUrl)
    ?? readHttpUrl(config.mwPublicBaseUrl)
    ?? readHttpUrl(options.requestOrigin)
    ?? readHostBaseUrl(options.requestHost, options.requestProtocol)
    ?? config.mwBaseUrl;
}

export function buildWikiPageUrl(title: string, options: string | WikiPageUrlOptions = {}): string {
  const baseUrl = typeof options === 'string'
    ? options
    : resolveWikiPublicBaseUrl(options);
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  return `${normalizedBaseUrl}/index.php/${encodeWikiTitlePath(title)}`;
}
