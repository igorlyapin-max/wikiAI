<?php
namespace MediaWiki\Extension\AIAssistant;

final class GatewayUrlHelper
{
  public static function forBrowser(string $gatewayUrl, string $publicGatewayUrl = ''): string
  {
    $publicGatewayUrl = rtrim(trim($publicGatewayUrl), '/');
    if ($publicGatewayUrl !== '') {
      return $publicGatewayUrl;
    }

    $gatewayUrl = rtrim(trim($gatewayUrl), '/');
    if ($gatewayUrl === '') {
      return '';
    }

    $parts = parse_url($gatewayUrl);
    if (!is_array($parts) || empty($parts['host'])) {
      return $gatewayUrl;
    }

    $host = strtolower((string)$parts['host']);
    if (!in_array($host, ['gateway', 'host.docker.internal'], true)) {
      return $gatewayUrl;
    }

    $browserHost = self::currentBrowserHost();
    if ($browserHost === '') {
      return $gatewayUrl;
    }

    $scheme = $parts['scheme'] ?? self::currentScheme();
    $port = isset($parts['port']) ? ':' . $parts['port'] : '';
    $path = $parts['path'] ?? '';
    $query = isset($parts['query']) ? '?' . $parts['query'] : '';

    return $scheme . '://' . $browserHost . $port . $path . $query;
  }

  public static function forMediaWikiServer(string $gatewayUrl): string
  {
    $gatewayUrl = rtrim(trim($gatewayUrl), '/');
    if ($gatewayUrl === '') {
      return '';
    }

    $parts = parse_url($gatewayUrl);
    if (!is_array($parts) || empty($parts['host'])) {
      return $gatewayUrl;
    }

    $host = strtolower((string)$parts['host']);
    if (!in_array($host, ['gateway', 'host.docker.internal'], true) || self::hostResolves($host)) {
      return $gatewayUrl;
    }

    $dockerGateway = self::defaultRouteGateway();
    if ($dockerGateway === '') {
      return $gatewayUrl;
    }

    $scheme = $parts['scheme'] ?? 'http';
    $port = isset($parts['port']) ? ':' . $parts['port'] : '';
    $path = $parts['path'] ?? '';
    $query = isset($parts['query']) ? '?' . $parts['query'] : '';

    return $scheme . '://' . $dockerGateway . $port . $path . $query;
  }

  private static function currentBrowserHost(): string
  {
    $host = (string)($_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? '');
    if ($host === '') {
      return '';
    }

    if (str_starts_with($host, '[')) {
      $end = strpos($host, ']');
      return $end === false ? $host : substr($host, 0, $end + 1);
    }

    return preg_replace('/:\d+$/', '', $host) ?: '';
  }

  private static function currentScheme(): string
  {
    $https = (string)($_SERVER['HTTPS'] ?? '');
    return $https !== '' && strtolower($https) !== 'off' ? 'https' : 'http';
  }

  private static function hostResolves(string $host): bool
  {
    return gethostbyname($host) !== $host;
  }

  private static function defaultRouteGateway(): string
  {
    $rows = @file('/proc/net/route', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($rows === false) {
      return '';
    }

    foreach (array_slice($rows, 1) as $row) {
      $columns = preg_split('/\s+/', trim($row));
      if (!is_array($columns) || count($columns) < 3 || $columns[1] !== '00000000') {
        continue;
      }

      $gateway = $columns[2];
      if (!preg_match('/^[0-9A-Fa-f]{8}$/', $gateway)) {
        continue;
      }

      $bytes = array_reverse(str_split($gateway, 2));
      return implode('.', array_map('hexdec', $bytes));
    }

    return '';
  }
}
