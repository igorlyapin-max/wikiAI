<?php
namespace MediaWiki\Extension\AIAssistant;

use MediaWiki\MediaWikiServices;
use SpecialPage;

class SpecialAIAssistant extends SpecialPage
{
  public function __construct()
  {
    parent::__construct('AIAssistant');
  }

  public function execute($subPage): void
  {
    $this->setHeaders();
    $this->getOutput()->setPageTitle($this->msg('aiassistant-title')->text());

    $config = $this->getConfig();
    $serverGatewayUrl = rtrim((string)$config->get('AIAssistantGatewayUrl'), '/');

    if ($this->getRequest()->getCheck('aiassistant-proxy')) {
      $this->proxyAssistantRequest($serverGatewayUrl);
      return;
    }

    $this->getOutput()->addModules('ext.aiassistant');

    $browserGatewayUrl = GatewayUrlHelper::forBrowser(
      $serverGatewayUrl,
      (string)$config->get('AIAssistantGatewayPublicUrl')
    );
    $proxyEnabled = $serverGatewayUrl !== '';
    $proxyBase = SpecialPage::getTitleFor('AIAssistant')->getLocalURL();

    $this->getOutput()->addHTML(sprintf(
      '<div id="ai-assistant-root" data-gateway-url="%s" data-proxy-enabled="%s" data-proxy-base="%s"></div>',
      htmlspecialchars($browserGatewayUrl, ENT_QUOTES),
      $proxyEnabled ? '1' : '0',
      htmlspecialchars($proxyBase, ENT_QUOTES)
    ));
  }

  protected function getGroupName(): string
  {
    return 'other';
  }

  private function proxyAssistantRequest(string $gatewayUrl): void
  {
    if ($gatewayUrl === '') {
      $this->sendJsonResponse(500, ['error' => 'Gateway URL is not configured']);
      return;
    }

    $request = $this->getRequest();
    $method = strtoupper($request->getMethod());
    if (!in_array($method, ['GET', 'POST'], true)) {
      $this->sendJsonResponse(405, ['error' => 'Method not allowed']);
      return;
    }

    $path = (string)$request->getVal('path', '');
    $pathOnly = parse_url($path, PHP_URL_PATH);
    if (
      !is_string($pathOnly) ||
      !$this->isAllowedAssistantProxyPath($pathOnly, $method) ||
      str_contains($path, '..') ||
      str_contains($path, "\r") ||
      str_contains($path, "\n") ||
      str_contains($path, '#')
    ) {
      $this->sendJsonResponse(400, ['error' => 'Invalid assistant proxy path']);
      return;
    }

    $serverGatewayUrl = GatewayUrlHelper::forMediaWikiServer($gatewayUrl);
    $scheme = strtolower((string)parse_url($serverGatewayUrl, PHP_URL_SCHEME));
    if (!in_array($scheme, ['http', 'https'], true)) {
      $this->sendJsonResponse(500, ['error' => 'Gateway URL scheme is not allowed']);
      return;
    }

    $url = $serverGatewayUrl . $path;
    $options = [
      'method' => $method,
      'timeout' => 60,
      'followRedirects' => false,
    ];
    if ($method === 'POST') {
      $rawBody = file_get_contents('php://input');
      $requestBody = $rawBody === false ? '' : $rawBody;
      $options['postData'] = $requestBody === '' ? '{}' : $requestBody;
    }

    try {
      $httpRequest = MediaWikiServices::getInstance()
        ->getHttpRequestFactory()
        ->create($url, $options, __METHOD__);
      $httpRequest->setHeader('Accept', 'application/json');
      if ($method === 'POST') {
        $httpRequest->setHeader('Content-Type', 'application/json');
      }

      $cookie = (string)($_SERVER['HTTP_COOKIE'] ?? '');
      if ($cookie !== '') {
        $httpRequest->setHeader('Cookie', $cookie);
      }

      $httpRequest->execute();
      $statusCode = $httpRequest->getStatus() ?: 502;
      $content = $httpRequest->getContent();
      $this->sendRawJsonResponse($statusCode, $content === null ? '' : $content);
    } catch (\Throwable $e) {
      wfDebugLog('aiassistant', 'Assistant proxy failed: ' . $e->getMessage());
      $this->sendJsonResponse(502, ['error' => 'Gateway proxy failed']);
    }
  }

  private function isAllowedAssistantProxyPath(string $pathOnly, string $method): bool
  {
    $getOnly = [
      '/api/ui/config',
      '/api/chat/sessions',
    ];
    $postOnly = [
      '/api/search',
      '/api/chat',
      '/api/chat/archive/export',
    ];

    if (in_array($pathOnly, $getOnly, true)) {
      return $method === 'GET';
    }
    if (in_array($pathOnly, $postOnly, true)) {
      return $method === 'POST';
    }

    return $method === 'GET' && preg_match('#^/api/chat/sessions/[^/?]+/messages$#', $pathOnly) === 1;
  }

  private function sendJsonResponse(int $statusCode, array $payload): void
  {
    $this->sendRawJsonResponse(
      $statusCode,
      json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}'
    );
  }

  private function sendRawJsonResponse(int $statusCode, string $content): void
  {
    $this->getOutput()->disable();
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo $content === '' ? '{}' : $content;
  }
}
