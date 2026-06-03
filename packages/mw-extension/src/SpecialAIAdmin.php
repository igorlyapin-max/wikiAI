<?php
namespace MediaWiki\Extension\AIAssistant;

use MediaWiki\MediaWikiServices;
use MediaWiki\Title\Title;
use SpecialPage;

class SpecialAIAdmin extends SpecialPage
{
  public function __construct()
  {
    parent::__construct('AIAdmin', 'aiadmin');
  }

  public function execute($subPage): void
  {
    $this->setHeaders();
    $this->getOutput()->setPageTitle($this->msg('aiadmin-title')->text());

    if (!$this->getUser()->isAllowed('aiadmin')) {
      if ($this->getRequest()->getCheck('aiadmin-proxy')) {
        $this->sendJsonResponse(403, ['error' => 'AI admin permission required']);
        return;
      }
      throw new \PermissionsError('aiadmin');
    }

    $config = $this->getConfig();
    $gatewayUrl = rtrim((string)$config->get('AIAssistantGatewayUrl'), '/');

    if ($this->getRequest()->getCheck('aiadmin-proxy')) {
      $this->proxyAdminRequest($gatewayUrl);
      return;
    }

    $apiBase = GatewayUrlHelper::forBrowser(
      $gatewayUrl,
      (string)$config->get('AIAssistantGatewayPublicUrl')
    );
    $mediaWikiSyncerUrl = rtrim($config->get('AIAssistantSyncerUrl'), '/');
    $adminProxyEnabled = $gatewayUrl !== '';

    $this->getOutput()->addHTML($this->getAdminStyles());
    $this->getOutput()->addHTML($this->renderShell());
    $this->getOutput()->addHTML($this->getAdminScript($apiBase, $mediaWikiSyncerUrl, $adminProxyEnabled));
  }

  private function proxyAdminRequest(string $gatewayUrl): void
  {
    if ($gatewayUrl === '') {
      $this->sendJsonResponse(500, ['error' => 'Gateway URL is not configured']);
      return;
    }

    $request = $this->getRequest();
    $method = strtoupper($request->getMethod());
    if (!in_array($method, ['GET', 'POST', 'DELETE'], true)) {
      $this->sendJsonResponse(405, ['error' => 'Method not allowed']);
      return;
    }

    $path = (string)$request->getVal('path', '');
    if (
      !str_starts_with($path, '/api/admin/') ||
      str_contains($path, '..') ||
      str_contains($path, "\r") ||
      str_contains($path, "\n") ||
      str_contains($path, '#')
    ) {
      $this->sendJsonResponse(400, ['error' => 'Invalid admin proxy path']);
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
    $requestBody = '';
    if ($method === 'POST') {
      $rawBody = file_get_contents('php://input');
      $requestBody = $rawBody === false ? '' : $rawBody;
      if ($requestBody === '') {
        $requestBody = '{}';
      }
      $options['postData'] = $requestBody;
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
      wfDebugLog('aiassistant', 'Admin proxy failed: ' . $e->getMessage());
      $this->sendJsonResponse(502, ['error' => 'Gateway proxy failed']);
    }
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

  private function msgHtml(string $key): string
  {
    return htmlspecialchars($this->msg($key)->text());
  }

  private function getAdminDocsUrl(): string
  {
    $title = Title::newFromText('WikiAIAdmin:Администрирование');
    return $title ? $title->getLocalURL() : '#';
  }

  private function getAdminI18nMessages(): array
  {
    $keys = [
      'aiadmin-action-add-mime',
      'aiadmin-action-add-ontology',
      'aiadmin-action-add-filter-value',
      'aiadmin-action-add-entity',
      'aiadmin-action-add-flag',
      'aiadmin-action-add-rule',
      'aiadmin-action-archive',
      'aiadmin-action-classify-fragment',
      'aiadmin-action-clear-cache',
      'aiadmin-action-clusterize',
      'aiadmin-action-delete',
      'aiadmin-action-edit',
      'aiadmin-action-export-json',
      'aiadmin-action-generate-vector',
      'aiadmin-action-load-more',
      'aiadmin-action-preview',
      'aiadmin-action-recalculate-trust-payload',
      'aiadmin-action-reindex-colbert',
      'aiadmin-action-refresh',
      'aiadmin-action-refresh-status',
      'aiadmin-action-open',
      'aiadmin-action-remove',
      'aiadmin-action-reset',
      'aiadmin-action-reset-policy',
      'aiadmin-action-save-entity',
      'aiadmin-action-save-model',
      'aiadmin-action-save-ontology',
      'aiadmin-action-save-policy',
      'aiadmin-action-save-profile',
      'aiadmin-action-save-rule',
      'aiadmin-action-save-scheduled-recalculation',
      'aiadmin-action-save-sensitive-properties',
      'aiadmin-action-save-conflict-detection',
      'aiadmin-action-search-facts',
      'aiadmin-action-search-smw-properties',
      'aiadmin-action-similar',
      'aiadmin-action-test',
      'aiadmin-action-test-conflict-detection',
      'aiadmin-assignment-chat',
      'aiadmin-assignment-conflicts',
      'aiadmin-assignment-embeddings',
      'aiadmin-assignment-reindex-enrichment',
      'aiadmin-autofill',
      'aiadmin-autofill-note',
      'aiadmin-chat-export-created',
      'aiadmin-chat-sessions-summary',
      'aiadmin-external-api',
      'aiadmin-confirm-delete-entity',
      'aiadmin-confirm-delete-ontology',
      'aiadmin-confirm-delete-rule',
      'aiadmin-empty-no-autofill-fields',
      'aiadmin-empty-no-scheduled-profiles',
      'aiadmin-empty-no-sensitive-properties',
      'aiadmin-empty-no-trust-entities',
      'aiadmin-empty-no-trust-rules',
      'aiadmin-empty-select-trust-entity',
      'aiadmin-error-property-required',
      'aiadmin-error-request-timeout',
      'aiadmin-field-active',
      'aiadmin-field-active-days',
      'aiadmin-field-ai-extractable',
      'aiadmin-field-ai-prompt-hint',
      'aiadmin-field-archive-days',
      'aiadmin-field-attachments',
      'aiadmin-field-autofill-min-confidence',
      'aiadmin-field-autofill-mode',
      'aiadmin-field-author-groups-csv',
      'aiadmin-field-author-group',
      'aiadmin-field-base-score',
      'aiadmin-field-base-url',
      'aiadmin-field-batch-size',
      'aiadmin-field-category-exclude-csv',
      'aiadmin-field-category-include-csv',
      'aiadmin-field-category',
      'aiadmin-field-categories-csv',
      'aiadmin-field-chunk-overlap',
      'aiadmin-field-chunk-separators-json',
      'aiadmin-field-chunk-size',
      'aiadmin-field-classify-threshold',
      'aiadmin-field-colbert-candidate-limit',
      'aiadmin-field-colbert-collection',
      'aiadmin-field-colbert-fail-mode',
      'aiadmin-field-colbert-min-score',
      'aiadmin-field-cors-origins',
      'aiadmin-field-data-type',
      'aiadmin-field-database-url',
      'aiadmin-field-default-max-pages',
      'aiadmin-field-description',
      'aiadmin-field-display-order',
      'aiadmin-field-document-policy',
      'aiadmin-field-dry-run',
      'aiadmin-field-dry-run-default',
      'aiadmin-field-days',
      'aiadmin-field-embedding-dimensions',
      'aiadmin-field-embeddings-base-url',
      'aiadmin-field-embeddings-model',
      'aiadmin-field-enabled',
      'aiadmin-field-entity',
      'aiadmin-field-entity-id',
      'aiadmin-field-entity-type',
      'aiadmin-field-exclude-from-index',
      'aiadmin-field-export-formats-csv',
      'aiadmin-field-export-messages',
      'aiadmin-field-export-metadata',
      'aiadmin-field-export-sources',
      'aiadmin-field-external-acl-mode',
      'aiadmin-field-external-anonymous-search',
      'aiadmin-field-external-api-enabled',
      'aiadmin-field-external-max-top-k',
      'aiadmin-field-external-mcp-enabled',
      'aiadmin-field-field',
      'aiadmin-field-flags-csv',
      'aiadmin-field-fragment',
      'aiadmin-field-gateway-port',
      'aiadmin-field-id',
      'aiadmin-field-conflict-confidence',
      'aiadmin-field-conflict-enabled',
      'aiadmin-field-conflict-max-chars-source',
      'aiadmin-field-conflict-max-sources',
      'aiadmin-field-conflict-model',
      'aiadmin-field-conflict-run-mode',
      'aiadmin-field-conflict-show-block',
      'aiadmin-field-conflict-trust-gap',
      'aiadmin-field-include-attachments',
      'aiadmin-field-include-drafts',
      'aiadmin-field-include-sensitive',
      'aiadmin-field-include-semantic-header',
      'aiadmin-field-index-attachments',
      'aiadmin-field-indexed',
      'aiadmin-field-interval-min',
      'aiadmin-field-lexical-gate-mode',
      'aiadmin-field-lexical-candidate-limit',
      'aiadmin-field-lexical-min-matched-terms',
      'aiadmin-field-lexical-weight',
      'aiadmin-field-label',
      'aiadmin-field-last-modified',
      'aiadmin-field-litellm-base-url',
      'aiadmin-field-litellm-model',
      'aiadmin-field-llm-key-configured',
      'aiadmin-field-llm-timeout-ms',
      'aiadmin-field-manual-approval',
      'aiadmin-field-max-active-chats',
      'aiadmin-field-max-chunks-per-page',
      'aiadmin-field-max-context-chars',
      'aiadmin-field-max-context-chunks',
      'aiadmin-field-max-page-chars',
      'aiadmin-field-max-pages',
      'aiadmin-field-max-pinned-chats',
      'aiadmin-field-max-scan',
      'aiadmin-field-max-tokens',
      'aiadmin-field-max-total-chats',
      'aiadmin-field-mediawiki-api-path',
      'aiadmin-field-mediawiki-base-url',
      'aiadmin-field-mediawiki-webhook-url',
      'aiadmin-field-min-chunk-length',
      'aiadmin-field-min-context-score',
      'aiadmin-field-min-final-score',
      'aiadmin-field-min-search-score',
      'aiadmin-field-model',
      'aiadmin-field-model-id',
      'aiadmin-field-modifier',
      'aiadmin-field-name',
      'aiadmin-field-namespace',
      'aiadmin-field-namespaces-csv',
      'aiadmin-field-notify-author',
      'aiadmin-field-ocr-languages',
      'aiadmin-field-on-limit-exceeded',
      'aiadmin-field-operator',
      'aiadmin-field-oidc-audience',
      'aiadmin-field-oidc-groups-claim',
      'aiadmin-field-oidc-issuer',
      'aiadmin-field-oidc-jwks-url',
      'aiadmin-field-oidc-subject-claim',
      'aiadmin-field-oidc-username-claim',
      'aiadmin-field-preview-model',
      'aiadmin-field-profile',
      'aiadmin-field-profile-id',
      'aiadmin-field-properties-json',
      'aiadmin-field-property-name',
      'aiadmin-field-property-value',
      'aiadmin-field-provider',
      'aiadmin-field-qdrant-collection',
      'aiadmin-field-qdrant-url',
      'aiadmin-field-recalculate-model',
      'aiadmin-field-recent-days',
      'aiadmin-field-redis-url',
      'aiadmin-field-reindex-llm-enrichment',
      'aiadmin-field-reindex-llm-max-chars',
      'aiadmin-field-reindex-llm-model',
      'aiadmin-field-require-sources',
      'aiadmin-field-require-verified-direct-answer',
      'aiadmin-field-retention-mode',
      'aiadmin-field-rerank-mode',
      'aiadmin-field-retry-backoff-ms',
      'aiadmin-field-retry-count',
      'aiadmin-field-rule-id',
      'aiadmin-field-run-mode',
      'aiadmin-field-schedule-min',
      'aiadmin-field-scheduled',
      'aiadmin-field-semantic-facts',
      'aiadmin-field-semantic-facts-in-context',
      'aiadmin-field-sensitive',
      'aiadmin-field-search-mode',
      'aiadmin-field-show-raw-scores',
      'aiadmin-field-show-sources',
      'aiadmin-field-smw-property',
      'aiadmin-field-smw-properties-csv',
      'aiadmin-field-smw-type',
      'aiadmin-field-staleness-penalty-per-year',
      'aiadmin-field-syncer-base-url',
      'aiadmin-field-syncer-token-configured',
      'aiadmin-field-syncer-mw-auth-configured',
      'aiadmin-field-syncer-mw-auth-source',
      'aiadmin-field-syncer-mw-auth-secret-ref',
      'aiadmin-field-syncer-mw-auth-pam',
      'aiadmin-field-syncer-mw-auth-cookie',
      'aiadmin-field-syncer-url',
      'aiadmin-field-system-prompt',
      'aiadmin-field-tags-csv',
      'aiadmin-field-tag',
      'aiadmin-field-temperature',
      'aiadmin-field-template',
      'aiadmin-field-templates-csv',
      'aiadmin-field-threshold',
      'aiadmin-field-timeout-ms',
      'aiadmin-field-title',
      'aiadmin-field-title-exclude-csv',
      'aiadmin-field-title-include-csv',
      'aiadmin-field-top-k',
      'aiadmin-field-value',
      'aiadmin-field-vector-candidate-limit',
      'aiadmin-field-vector-only-fallback-enabled',
      'aiadmin-field-vector-only-fallback-min-score',
      'aiadmin-field-vector-weight',
      'aiadmin-field-weight',
      'aiadmin-field-webhook-event-delete',
      'aiadmin-field-webhook-event-edit',
      'aiadmin-field-webhook-event-move',
      'aiadmin-field-webhook-event-protect',
      'aiadmin-help-category-exclude-filter',
      'aiadmin-help-category-include-filter',
      'aiadmin-help-conflict-detection',
      'aiadmin-help-ontology-actions',
      'aiadmin-help-ontology-selected',
      'aiadmin-help-property-value-manual',
      'aiadmin-help-reindex-max-pages',
      'aiadmin-help-reindex-llm-enrichment',
      'aiadmin-help-sensitive-properties',
      'aiadmin-help-hybrid-search',
      'aiadmin-help-colbert-index',
      'aiadmin-help-colbert-rerank',
      'aiadmin-help-trust-rule-condition',
      'aiadmin-help-trust-rule-flags',
      'aiadmin-help-trust-entities',
      'aiadmin-help-trust-preview',
      'aiadmin-help-trust-recalc',
      'aiadmin-help-trust-rules',
      'aiadmin-help-title-exclude-filter',
      'aiadmin-help-title-include-filter',
      'aiadmin-label-available-categories',
      'aiadmin-loading',
      'aiadmin-loading-ontology',
      'aiadmin-loading-scheduler',
      'aiadmin-message-archived',
      'aiadmin-message-cache-cleared',
      'aiadmin-message-classification-ready',
      'aiadmin-message-clusterization-ready',
      'aiadmin-message-deleted',
      'aiadmin-message-deleted-with-count',
      'aiadmin-message-generating',
      'aiadmin-message-no-chat-messages',
      'aiadmin-message-preview-complete',
      'aiadmin-message-recalculation-complete',
      'aiadmin-message-reindex-started',
      'aiadmin-message-reset',
      'aiadmin-message-refreshed',
      'aiadmin-message-running',
      'aiadmin-message-saved',
      'aiadmin-message-searching',
      'aiadmin-message-similarities-ready',
      'aiadmin-message-test-completed',
      'aiadmin-message-vector-generated',
      'aiadmin-error-save-ontology-first',
      'aiadmin-error-smw-properties-route',
      'aiadmin-error-select-smw-property',
      'aiadmin-metric-scan-complete',
      'aiadmin-metric-scanned-points',
      'aiadmin-metric-semantic-pages',
      'aiadmin-metric-semantic-points',
      'aiadmin-placeholder-corporate-default',
      'aiadmin-placeholder-current-llm-model',
      'aiadmin-placeholder-document-fragment',
      'aiadmin-placeholder-optional',
      'aiadmin-placeholder-condition-value',
      'aiadmin-placeholder-search-smw-property',
      'aiadmin-placeholder-select-category',
      'aiadmin-placeholder-select-smw-property',
      'aiadmin-placeholder-verified-documents',
      'aiadmin-reindex-status-line',
      'aiadmin-reindex-paid-counters',
      'aiadmin-reindex-current-title',
      'aiadmin-search-summary',
      'aiadmin-status-llm-test',
      'aiadmin-status-last-embedding-test',
      'aiadmin-status-indexed-smw-properties',
      'aiadmin-status-last-webhook-test',
      'aiadmin-status-autofill-summary',
      'aiadmin-status-ontology-no-selection',
      'aiadmin-status-ontology-selected',
      'aiadmin-status-ontology-derived',
      'aiadmin-status-smw-properties-loaded',
      'aiadmin-status-bm25-index',
      'aiadmin-status-colbert-test',
      'aiadmin-status-external-api-capabilities',
      'aiadmin-status-mediawiki-webhook-match',
      'aiadmin-status-mediawiki-webhook-mismatch',
      'aiadmin-status-retention-effective',
      'aiadmin-status-schedule-line',
      'aiadmin-section-active-trust-model',
      'aiadmin-section-colbert-index',
      'aiadmin-section-colbert-rerank',
      'aiadmin-section-conflict-detection',
      'aiadmin-section-external-oidc',
      'aiadmin-section-hybrid-search',
      'aiadmin-section-model-assignments',
      'aiadmin-section-trust-entities',
      'aiadmin-section-trust-preview',
      'aiadmin-section-trust-recalc',
      'aiadmin-section-trust-rules',
      'aiadmin-trust-source-legacy-entity',
      'aiadmin-trust-source-legacy-rule',
      'aiadmin-trust-source-rule',
      'aiadmin-tab-audit',
      'aiadmin-tab-autofill',
      'aiadmin-tab-chat-retention',
      'aiadmin-tab-documents',
      'aiadmin-tab-embeddings',
      'aiadmin-tab-external-api',
      'aiadmin-tab-indexing',
      'aiadmin-tab-llm',
      'aiadmin-tab-ontology',
      'aiadmin-tab-overview',
      'aiadmin-tab-rag',
      'aiadmin-tab-sensitive',
      'aiadmin-tab-services',
      'aiadmin-tab-trust',
      'aiadmin-tab-webhook',
      'aiadmin-table-action',
      'aiadmin-table-actions',
      'aiadmin-table-active',
      'aiadmin-table-age-years',
      'aiadmin-table-applied',
      'aiadmin-table-actor',
      'aiadmin-table-base',
      'aiadmin-table-check',
      'aiadmin-table-chunking',
      'aiadmin-table-collection',
      'aiadmin-table-confidence',
      'aiadmin-table-condition',
      'aiadmin-table-conversation',
      'aiadmin-table-created',
      'aiadmin-table-decisions',
      'aiadmin-table-defaults',
      'aiadmin-table-details',
      'aiadmin-table-display-order',
      'aiadmin-table-dry-run',
      'aiadmin-table-eligible',
      'aiadmin-table-enabled',
      'aiadmin-table-entity',
      'aiadmin-table-error',
      'aiadmin-table-extract',
      'aiadmin-table-facts',
      'aiadmin-table-failed',
      'aiadmin-table-filters',
      'aiadmin-table-flags',
      'aiadmin-table-id',
      'aiadmin-table-indexed',
      'aiadmin-table-interval',
      'aiadmin-table-last',
      'aiadmin-table-last-message',
      'aiadmin-table-matched-values',
      'aiadmin-table-max-bytes',
      'aiadmin-table-message-count',
      'aiadmin-table-message',
      'aiadmin-table-mime',
      'aiadmin-table-min-context',
      'aiadmin-table-mode',
      'aiadmin-table-model',
      'aiadmin-table-modifier',
      'aiadmin-table-name',
      'aiadmin-table-namespace',
      'aiadmin-table-namespaces',
      'aiadmin-table-next',
      'aiadmin-table-ocr-languages',
      'aiadmin-table-page',
      'aiadmin-table-pages',
      'aiadmin-table-policies',
      'aiadmin-table-points',
      'aiadmin-table-property',
      'aiadmin-table-qdrant-collection',
      'aiadmin-table-running',
      'aiadmin-table-scanned',
      'aiadmin-table-scheduled-profile',
      'aiadmin-table-score',
      'aiadmin-table-sensitive',
      'aiadmin-table-staleness-penalty',
      'aiadmin-table-status',
      'aiadmin-table-source',
      'aiadmin-table-sources',
      'aiadmin-table-role',
      'aiadmin-table-type',
      'aiadmin-table-updated',
      'aiadmin-table-user',
      'aiadmin-table-value',
      'aiadmin-table-values',
      'aiadmin-table-vector',
      'aiadmin-table-vector-source',
      'aiadmin-table-weight',
      'aiadmin-value-no',
      'aiadmin-value-autofill-mode-apply-empty',
      'aiadmin-value-autofill-mode-suggest-only',
      'aiadmin-value-conflict-mode-always',
      'aiadmin-value-conflict-mode-manual',
      'aiadmin-value-conflict-mode-risk-only',
      'aiadmin-value-no-categories',
      'aiadmin-value-content-namespace',
      'aiadmin-value-external-acl-groups-only',
      'aiadmin-value-external-acl-mediawiki-check',
      'aiadmin-value-search-mode-hybrid',
      'aiadmin-value-search-mode-hybrid-colbert',
      'aiadmin-value-search-mode-colbert-full',
      'aiadmin-value-search-mode-vector-only',
      'aiadmin-value-lexical-gate-off',
      'aiadmin-value-lexical-gate-when-bm25',
      'aiadmin-value-fail-search',
      'aiadmin-value-fallback-current',
      'aiadmin-value-none',
      'aiadmin-value-rerank-colbert-v2',
      'aiadmin-value-rerank-none',
      'aiadmin-value-system-namespace',
      'aiadmin-value-unknown',
      'aiadmin-value-yes',
    ];

    $messages = [];
    foreach ($keys as $key) {
      $messages[$key] = $this->msg($key)->text();
    }
    return $messages;
  }

  private function getAdminStyles(): string
  {
    return '<style>
      .ai-admin-wrapper { max-width: 1180px; }
      .ai-admin-header { display: flex; justify-content: flex-end; margin: 0 0 8px; }
      .ai-admin-help-link {
        border: 1px solid #a2a9b1; background: #f8f9fa; color: #111827;
        border-radius: 2px; padding: 6px 10px; text-decoration: none;
      }
      .ai-admin-help-link:hover { background: #eaecf0; text-decoration: none; }
      .ai-admin-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
      .ai-admin-tab {
        border: 1px solid #a2a9b1; background: #f8f9fa; color: #111827;
        border-radius: 2px; padding: 7px 10px; cursor: pointer;
      }
      .ai-admin-tab.active { background: #7C3AED; border-color: #7C3AED; color: #fff; }
      .ai-admin-panel { display: none; }
      .ai-admin-panel.active { display: block; }
      .ai-admin-card {
        background: #fff; border: 1px solid #a2a9b1; border-radius: 2px;
        padding: 16px; margin-bottom: 16px;
      }
      .ai-admin-card h2 {
        margin: 0 0 12px; font-size: 1.2em; border-bottom: 1px solid #eaecf0;
        padding-bottom: 8px;
      }
      .ai-admin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
      .ai-admin-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
      .ai-admin-row label { width: 220px; font-weight: bold; }
      .ai-admin-row input, .ai-admin-row textarea, .ai-admin-row select {
        min-width: 180px; padding: 6px 8px; border: 1px solid #a2a9b1; border-radius: 2px;
      }
      .ai-admin-row input[readonly] { background: #f8f9fa; color: #54595d; }
      .ai-admin-row textarea { min-height: 90px; width: min(620px, 100%); }
      .ai-admin-table { width: 100%; border-collapse: collapse; }
      .ai-admin-table th, .ai-admin-table td { border: 1px solid #a2a9b1; padding: 6px; text-align: left; }
      .ai-admin-table th { background: #f8f9fa; }
      .ai-admin-table input, .ai-admin-table select { width: 100%; box-sizing: border-box; }
      .ai-admin-table tbody tr.ai-admin-clickable-row { cursor: pointer; }
      .ai-admin-table tbody tr.ai-admin-clickable-row:hover { background: #f8f9fa; }
      .ai-admin-table tbody tr.ai-admin-row-selected { background: #ede9fe; }
      .ai-admin-sort-button { border: 0; background: transparent; cursor: pointer; font-weight: bold; padding: 0; text-align: left; }
      .ai-admin-action-cell { white-space: nowrap; }
      .ai-admin-btn {
        display: inline-block; padding: 8px 14px; border: 1px solid #a2a9b1;
        border-radius: 2px; background: #f8f9fa; cursor: pointer; margin-right: 8px;
      }
      .ai-admin-btn:hover { background: #eaecf0; }
      .ai-admin-btn-primary { background: #3366cc; border-color: #3366cc; color: #fff; }
      .ai-admin-btn-primary:hover { background: #2a56b0; }
      .ai-admin-btn-danger { background: #dd3333; border-color: #dd3333; color: #fff; }
      .ai-admin-btn:disabled { opacity: .55; cursor: not-allowed; }
      .ai-admin-status-ok { color: #14866d; font-weight: bold; }
      .ai-admin-status-error { color: #d33; font-weight: bold; }
      .ai-admin-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
      .ai-admin-summary-item { background: #f8f9fa; border: 1px solid #eaecf0; border-radius: 2px; padding: 8px 10px; min-width: 120px; }
      .ai-admin-summary-item strong { display: block; font-size: 1.1em; }
      .ai-admin-search-results { margin-top: 12px; }
      .ai-admin-search-results pre { white-space: pre-wrap; margin: 0; font-size: 12px; }
      .ai-admin-muted { color: #72777d; font-size: 12px; }
      .ai-admin-hidden { display: none !important; }
      .ai-admin-field { display: flex; flex-direction: column; gap: 4px; min-width: 260px; }
      .ai-admin-field label { width: auto; }
      .ai-admin-field input { min-width: 260px; }
      .ai-admin-category-controls { display: flex; flex-wrap: wrap; gap: 6px; }
      .ai-admin-category-select { width: min(360px, 100%); min-height: 132px; box-sizing: border-box; }
      .ai-admin-chip-list { display: flex; flex-wrap: wrap; gap: 4px; min-height: 28px; }
      .ai-admin-chip {
        display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px;
        border: 1px solid #a2a9b1; border-radius: 2px; background: #f8f9fa;
      }
      .ai-admin-chip button {
        border: 0; background: transparent; cursor: pointer; padding: 0 2px; font-weight: bold;
      }
    </style>';
  }

  private function renderShell(): string
  {
    $docsUrl = htmlspecialchars($this->getAdminDocsUrl());
    return '<div class="ai-admin-wrapper">
      <div class="ai-admin-header">
        <a class="ai-admin-help-link" href="' . $docsUrl . '" title="' . $this->msgHtml('aiadmin-help-title') . '">' . $this->msgHtml('aiadmin-help-link') . '</a>
      </div>
      <div class="ai-admin-tabs">
        <button type="button" class="ai-admin-tab active" data-ai-tab="overview">' . $this->msgHtml('aiadmin-tab-overview') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="services">' . $this->msgHtml('aiadmin-tab-services') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="external-api">' . $this->msgHtml('aiadmin-tab-external-api') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="llm">' . $this->msgHtml('aiadmin-tab-llm') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="embeddings">' . $this->msgHtml('aiadmin-tab-embeddings') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="rag">' . $this->msgHtml('aiadmin-tab-rag') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="documents">' . $this->msgHtml('aiadmin-tab-documents') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="chat-retention">' . $this->msgHtml('aiadmin-tab-chat-retention') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="trust">' . $this->msgHtml('aiadmin-tab-trust') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="webhook">' . $this->msgHtml('aiadmin-tab-webhook') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="ontology">' . $this->msgHtml('aiadmin-tab-ontology') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="autofill">' . $this->msgHtml('aiadmin-tab-autofill') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="sensitive">' . $this->msgHtml('aiadmin-tab-sensitive') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="indexing">' . $this->msgHtml('aiadmin-tab-indexing') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="audit">' . $this->msgHtml('aiadmin-tab-audit') . '</button>
      </div>
      <div class="ai-admin-card ai-admin-panel active" data-ai-panel="overview">
        <h2>' . htmlspecialchars($this->msg('aiadmin-status')->text()) . '</h2>
        <div id="aiadmin-health">' . $this->msgHtml('aiadmin-loading') . '</div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="services">
        <h2>' . htmlspecialchars($this->msg('aiadmin-services')->text()) . '</h2>
        <form id="aiadmin-service-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-service-config">' . $this->msgHtml('aiadmin-save') . '</button>
        <button type="button" class="ai-admin-btn" id="aiadmin-test-service-config">' . $this->msgHtml('aiadmin-action-test') . '</button>
        <span id="aiadmin-service-status"></span>
        <div id="aiadmin-service-test" class="ai-admin-search-results"></div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="external-api">
        <h2>' . htmlspecialchars($this->msg('aiadmin-external-api')->text()) . '</h2>
        <form id="aiadmin-external-api-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-external-api">' . $this->msgHtml('aiadmin-save') . '</button>
        <span id="aiadmin-external-api-status"></span>
        <div id="aiadmin-external-api-capabilities" class="ai-admin-muted"></div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="llm">
        <h2>' . htmlspecialchars($this->msg('aiadmin-settings')->text()) . '</h2>
        <form id="aiadmin-settings-form"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-settings">' . $this->msgHtml('aiadmin-save') . '</button>
        <button type="button" class="ai-admin-btn" id="aiadmin-reset-settings">' . $this->msgHtml('aiadmin-action-reset') . '</button>
        <button type="button" class="ai-admin-btn" id="aiadmin-test-llm-config">' . $this->msgHtml('aiadmin-action-test') . '</button>
        <span id="aiadmin-settings-status"></span>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="embeddings">
        <h2>' . htmlspecialchars($this->msg('aiadmin-embeddings')->text()) . '</h2>
        <form id="aiadmin-embedding-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-embedding-config">' . $this->msgHtml('aiadmin-save') . '</button>
        <button type="button" class="ai-admin-btn" id="aiadmin-test-embedding-config">' . $this->msgHtml('aiadmin-action-test') . '</button>
        <span id="aiadmin-embedding-status"></span>
        <div id="aiadmin-embedding-test" class="ai-admin-search-results"></div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="rag">
        <h2>' . htmlspecialchars($this->msg('aiadmin-rag')->text()) . '</h2>
        <form id="aiadmin-rag-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-rag-config">' . $this->msgHtml('aiadmin-save') . '</button>
        <span id="aiadmin-rag-status"></span>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="documents">
        <h2>' . htmlspecialchars($this->msg('aiadmin-documents')->text()) . '</h2>
        <div id="aiadmin-document-policy">' . $this->msgHtml('aiadmin-loading') . '</div>
        <div class="ai-admin-row">
          <input type="text" id="aiadmin-new-mime" placeholder="application/example" />
          <select id="aiadmin-new-mode">
            <option value="metadata">metadata</option>
            <option value="text">text</option>
            <option value="ocr">ocr</option>
            <option value="disabled">disabled</option>
          </select>
          <button type="button" class="ai-admin-btn" id="aiadmin-add-mime">' . $this->msgHtml('aiadmin-action-add-mime') . '</button>
        </div>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-policy">' . $this->msgHtml('aiadmin-action-save-policy') . '</button>
        <button type="button" class="ai-admin-btn" id="aiadmin-reset-policy">' . $this->msgHtml('aiadmin-action-reset-policy') . '</button>
        <span id="aiadmin-policy-status"></span>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="chat-retention">
        <h2>' . htmlspecialchars($this->msg('aiadmin-chat-retention')->text()) . '</h2>
        <form id="aiadmin-chat-retention-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-chat-retention">' . $this->msgHtml('aiadmin-save') . '</button>
        <span id="aiadmin-chat-retention-status"></span>
        <div id="aiadmin-chat-retention-effective" class="ai-admin-muted"></div>
        <div id="aiadmin-chat-sessions" class="ai-admin-search-results">' . $this->msgHtml('aiadmin-loading') . '</div>
        <div class="ai-admin-muted">' . htmlspecialchars($this->msg('aiadmin-chat-retention-note')->text()) . '</div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="trust">
        <h2>' . htmlspecialchars($this->msg('aiadmin-trust')->text()) . '</h2>
        <h3>' . $this->msgHtml('aiadmin-section-active-trust-model') . '</h3>
        <div id="aiadmin-trust-models">' . $this->msgHtml('aiadmin-loading') . '</div>
        <form id="aiadmin-trust-model-form">
          <div class="ai-admin-row">
            <label for="trust-model-id">' . $this->msgHtml('aiadmin-field-model-id') . '</label>
            <input type="text" id="trust-model-id" placeholder="corp-default" />
            <label for="trust-model-name">' . $this->msgHtml('aiadmin-field-name') . '</label>
            <input type="text" id="trust-model-name" placeholder="' . $this->msgHtml('aiadmin-placeholder-corporate-default') . '" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-base-score">' . $this->msgHtml('aiadmin-field-base-score') . '</label>
            <input type="number" id="trust-base-score" min="0" max="1" step="0.01" />
            <label for="trust-min-context">' . $this->msgHtml('aiadmin-field-min-context-score') . '</label>
            <input type="number" id="trust-min-context" min="0" max="1" step="0.01" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-model-active">' . $this->msgHtml('aiadmin-field-active') . '</label>
            <input type="checkbox" id="trust-model-active" />
            <label for="trust-include-drafts">' . $this->msgHtml('aiadmin-field-include-drafts') . '</label>
            <input type="checkbox" id="trust-include-drafts" />
            <label for="trust-staleness-penalty">' . $this->msgHtml('aiadmin-field-staleness-penalty-per-year') . '</label>
            <input type="number" id="trust-staleness-penalty" min="0" max="1" step="0.01" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-require-verified">' . $this->msgHtml('aiadmin-field-require-verified-direct-answer') . '</label>
            <input type="checkbox" id="trust-require-verified" />
            <label for="trust-require-sources">' . $this->msgHtml('aiadmin-field-require-sources') . '</label>
            <input type="checkbox" id="trust-require-sources" />
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-save-trust-model">' . $this->msgHtml('aiadmin-action-save-model') . '</button>
          <span id="aiadmin-trust-model-status"></span>
        </form>
        <h3>' . $this->msgHtml('aiadmin-section-conflict-detection') . '</h3>
        <div class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-conflict-detection') . '</div>
        <form id="aiadmin-conflict-detection-form"></form>
        <button type="button" class="ai-admin-btn" id="aiadmin-save-conflict-detection">' . $this->msgHtml('aiadmin-action-save-conflict-detection') . '</button>
        <button type="button" class="ai-admin-btn" id="aiadmin-test-conflict-detection">' . $this->msgHtml('aiadmin-action-test-conflict-detection') . '</button>
        <span id="aiadmin-conflict-detection-status"></span>
        <div id="aiadmin-conflict-detection-test" class="ai-admin-search-results"></div>
        <h3>' . $this->msgHtml('aiadmin-section-trust-entities') . '</h3>
        <div class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-trust-entities') . '</div>
        <div id="aiadmin-trust-entities" class="ai-admin-search-results"></div>
        <form id="aiadmin-trust-entity-form" class="ai-admin-hidden">
          <div class="ai-admin-row">
            <label for="trust-entity-id">' . $this->msgHtml('aiadmin-field-entity-id') . '</label>
            <input type="text" id="trust-entity-id" placeholder="verified-docs" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-entity-type">' . $this->msgHtml('aiadmin-field-entity-type') . '</label>
            <select id="trust-entity-type">
              <option value="namespace">namespace</option>
              <option value="category">category</option>
              <option value="tag">tag</option>
              <option value="author_group">author_group</option>
              <option value="page_property">page_property</option>
              <option value="template">template</option>
              <option value="date_property">date_property</option>
              <option value="smw_property">smw_property</option>
            </select>
            <label for="trust-entity-name">' . $this->msgHtml('aiadmin-field-name') . '</label>
            <input type="text" id="trust-entity-name" placeholder="' . $this->msgHtml('aiadmin-placeholder-verified-documents') . '" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-entity-value">' . $this->msgHtml('aiadmin-field-value') . '</label>
            <input type="text" id="trust-entity-value" list="trust-entity-value-options" placeholder="Статус документа=Утвержден" />
            <datalist id="trust-entity-value-options"></datalist>
            <label for="trust-entity-weight">' . $this->msgHtml('aiadmin-field-weight') . '</label>
            <input type="number" id="trust-entity-weight" min="-1" max="1" step="0.01" />
            <label for="trust-entity-enabled">' . $this->msgHtml('aiadmin-field-enabled') . '</label>
            <input type="checkbox" id="trust-entity-enabled" checked />
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-add-trust-entity">' . $this->msgHtml('aiadmin-action-add-entity') . '</button>
          <button type="button" class="ai-admin-btn" id="aiadmin-save-trust-entity">' . $this->msgHtml('aiadmin-action-save-entity') . '</button>
          <button type="button" class="ai-admin-btn ai-admin-btn-danger" id="aiadmin-delete-trust-entity">' . $this->msgHtml('aiadmin-action-delete') . '</button>
          <span id="aiadmin-trust-entity-status"></span>
        </form>
        <h3 class="ai-admin-hidden">' . $this->msgHtml('aiadmin-section-trust-rules') . '</h3>
        <div class="ai-admin-muted ai-admin-hidden">' . $this->msgHtml('aiadmin-help-trust-rules') . '</div>
        <div id="aiadmin-trust-selected-entity" class="ai-admin-muted ai-admin-hidden"></div>
        <div id="aiadmin-trust-rules" class="ai-admin-search-results ai-admin-hidden"></div>
        <form id="aiadmin-trust-rule-form">
          <div class="ai-admin-row">
            <label for="trust-rule-id">' . $this->msgHtml('aiadmin-field-rule-id') . '</label>
            <input type="text" id="trust-rule-id" placeholder="boost-approved" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-rule-name">' . $this->msgHtml('aiadmin-field-name') . '</label>
            <input type="text" id="trust-rule-name" placeholder="Boost approved docs" />
            <label for="trust-rule-modifier">' . $this->msgHtml('aiadmin-field-modifier') . '</label>
            <input type="number" id="trust-rule-modifier" min="-1" max="1" step="0.01" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-rule-field">' . $this->msgHtml('aiadmin-field-field') . '</label>
            <select id="trust-rule-field">
              <option value="namespace">namespace</option>
              <option value="title">title</option>
              <option value="category">category</option>
              <option value="tag">tag</option>
              <option value="author_group">author_group</option>
              <option value="template">template</option>
              <option value="property">property</option>
              <option value="status">status</option>
              <option value="date_property">date_property</option>
            </select>
            <label for="trust-rule-operator">' . $this->msgHtml('aiadmin-field-operator') . '</label>
            <select id="trust-rule-operator">
              <option value="equals">equals</option>
              <option value="contains">contains</option>
              <option value="starts_with">starts_with</option>
              <option value="exists">exists</option>
              <option value="older_than_days">older_than_days</option>
              <option value="newer_than_days">newer_than_days</option>
            </select>
          </div>
          <div class="ai-admin-row">
            <label for="trust-rule-property">' . $this->msgHtml('aiadmin-field-property-name') . '</label>
            <input type="text" id="trust-rule-property" list="trust-rule-property-options" placeholder="Статус документа" />
            <datalist id="trust-rule-property-options"></datalist>
            <label for="trust-rule-value">' . $this->msgHtml('aiadmin-field-value') . '</label>
            <input type="text" id="trust-rule-value" list="trust-rule-value-options" placeholder="Утвержден" />
            <select id="trust-rule-value-select" class="ai-admin-hidden"></select>
            <datalist id="trust-rule-value-options"></datalist>
          </div>
          <div id="aiadmin-trust-rule-condition-help" class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-trust-rule-condition') . '</div>
          <div class="ai-admin-row">
            <label for="trust-rule-new-flag">' . $this->msgHtml('aiadmin-field-flags-csv') . '</label>
            <input type="hidden" id="trust-rule-flags" />
            <div class="ai-admin-field">
              <div id="trust-rule-flags-list" class="ai-admin-chip-list"></div>
              <div class="ai-admin-category-controls">
                <input type="text" id="trust-rule-new-flag" list="trust-rule-flag-options" placeholder="verified" />
                <button type="button" class="ai-admin-btn" id="aiadmin-add-trust-rule-flag">' . $this->msgHtml('aiadmin-action-add-flag') . '</button>
              </div>
              <datalist id="trust-rule-flag-options"></datalist>
              <div id="aiadmin-trust-rule-flags-help" class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-trust-rule-flags') . '</div>
            </div>
            <label for="trust-rule-order">' . $this->msgHtml('aiadmin-field-display-order') . '</label>
            <input type="number" id="trust-rule-order" min="0" max="10000" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-rule-enabled">' . $this->msgHtml('aiadmin-field-enabled') . '</label>
            <input type="checkbox" id="trust-rule-enabled" checked />
            <label for="trust-rule-exclude">' . $this->msgHtml('aiadmin-field-exclude-from-index') . '</label>
            <input type="checkbox" id="trust-rule-exclude" />
            <label for="trust-rule-manual">' . $this->msgHtml('aiadmin-field-manual-approval') . '</label>
            <input type="checkbox" id="trust-rule-manual" />
            <label for="trust-rule-notify">' . $this->msgHtml('aiadmin-field-notify-author') . '</label>
            <input type="checkbox" id="trust-rule-notify" />
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-add-trust-rule">' . $this->msgHtml('aiadmin-action-add-rule') . '</button>
          <button type="button" class="ai-admin-btn" id="aiadmin-save-trust-rule">' . $this->msgHtml('aiadmin-action-save-rule') . '</button>
          <button type="button" class="ai-admin-btn ai-admin-btn-danger" id="aiadmin-delete-trust-rule">' . $this->msgHtml('aiadmin-action-delete') . '</button>
          <span id="aiadmin-trust-rule-status"></span>
        </form>
        <h3>' . $this->msgHtml('aiadmin-section-trust-preview') . '</h3>
        <div class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-trust-preview') . '</div>
        <form id="aiadmin-trust-preview-form">
          <div class="ai-admin-row">
            <label for="trust-preview-title">' . $this->msgHtml('aiadmin-field-title') . '</label>
            <input type="text" id="trust-preview-title" list="trust-preview-title-options" value="CorpIT:Инструкция VPN" />
            <datalist id="trust-preview-title-options"></datalist>
            <label for="trust-preview-namespace">' . $this->msgHtml('aiadmin-field-namespace') . '</label>
            <select id="trust-preview-namespace" data-default="3030"></select>
          </div>
          <div class="ai-admin-row">
            <div class="ai-admin-field">
              <label for="trust-preview-categories-search">' . $this->msgHtml('aiadmin-field-categories-csv') . '</label>
              <input type="hidden" id="trust-preview-categories" value="ИТ, Регламенты" />
              <div id="trust-preview-categories-chips" class="ai-admin-chip-list"></div>
              <div class="ai-admin-category-controls">
                <input type="search" id="trust-preview-categories-search" list="trust-preview-category-options" placeholder="ИТ" />
                <button type="button" class="ai-admin-btn" id="trust-preview-categories-add">' . $this->msgHtml('aiadmin-action-add-filter-value') . '</button>
              </div>
              <datalist id="trust-preview-category-options"></datalist>
            </div>
            <div class="ai-admin-field">
              <label for="trust-preview-tags-search">' . $this->msgHtml('aiadmin-field-tags-csv') . '</label>
              <input type="hidden" id="trust-preview-tags" value="verified" />
              <div id="trust-preview-tags-chips" class="ai-admin-chip-list"></div>
              <div class="ai-admin-category-controls">
                <input type="search" id="trust-preview-tags-search" list="trust-preview-tag-options" placeholder="verified" />
                <button type="button" class="ai-admin-btn" id="trust-preview-tags-add">' . $this->msgHtml('aiadmin-action-add-filter-value') . '</button>
              </div>
              <datalist id="trust-preview-tag-options"></datalist>
            </div>
          </div>
          <div class="ai-admin-row">
            <div class="ai-admin-field">
              <label for="trust-preview-author-groups-search">' . $this->msgHtml('aiadmin-field-author-groups-csv') . '</label>
              <input type="hidden" id="trust-preview-author-groups" value="ai-it" />
              <div id="trust-preview-author-groups-chips" class="ai-admin-chip-list"></div>
              <div class="ai-admin-category-controls">
                <input type="search" id="trust-preview-author-groups-search" list="trust-preview-author-group-options" placeholder="ai-it" />
                <button type="button" class="ai-admin-btn" id="trust-preview-author-groups-add">' . $this->msgHtml('aiadmin-action-add-filter-value') . '</button>
              </div>
              <datalist id="trust-preview-author-group-options"></datalist>
            </div>
            <div class="ai-admin-field">
              <label for="trust-preview-templates-search">' . $this->msgHtml('aiadmin-field-templates-csv') . '</label>
              <input type="hidden" id="trust-preview-templates" value="ApprovedDocument" />
              <div id="trust-preview-templates-chips" class="ai-admin-chip-list"></div>
              <div class="ai-admin-category-controls">
                <input type="search" id="trust-preview-templates-search" list="trust-preview-template-options" placeholder="ApprovedDocument" />
                <button type="button" class="ai-admin-btn" id="trust-preview-templates-add">' . $this->msgHtml('aiadmin-action-add-filter-value') . '</button>
              </div>
              <datalist id="trust-preview-template-options"></datalist>
            </div>
          </div>
          <div class="ai-admin-row">
            <label for="trust-preview-last-modified">' . $this->msgHtml('aiadmin-field-last-modified') . '</label>
            <input type="text" id="trust-preview-last-modified" placeholder="2024-01-15T10:00:00Z" />
          </div>
          <div class="ai-admin-row">
            <label for="trust-preview-properties">' . $this->msgHtml('aiadmin-field-properties-json') . '</label>
            <textarea id="trust-preview-properties">{ "Статус документа": "Утвержден" }</textarea>
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-run-trust-preview">' . $this->msgHtml('aiadmin-action-preview') . '</button>
          <span id="aiadmin-trust-preview-status"></span>
        </form>
        <div id="aiadmin-trust-preview-result" class="ai-admin-search-results"></div>
        <h3>' . $this->msgHtml('aiadmin-section-trust-recalc') . '</h3>
        <div class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-trust-recalc') . '</div>
        <form id="aiadmin-trust-recalc-form">
          <div class="ai-admin-row">
            <label for="trust-recalc-maxscan">' . $this->msgHtml('aiadmin-field-max-scan') . '</label>
            <input type="number" id="trust-recalc-maxscan" value="1000" min="1" max="100000" />
            <label for="trust-recalc-batchsize">' . $this->msgHtml('aiadmin-field-batch-size') . '</label>
            <input type="number" id="trust-recalc-batchsize" value="128" min="1" max="500" />
            <label for="trust-recalc-dryrun">' . $this->msgHtml('aiadmin-field-dry-run') . '</label>
            <input type="checkbox" id="trust-recalc-dryrun" checked />
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-run-trust-recalc">' . $this->msgHtml('aiadmin-action-recalculate-trust-payload') . '</button>
          <span id="aiadmin-trust-recalc-status"></span>
        </form>
        <div id="aiadmin-trust-recalc-result" class="ai-admin-search-results"></div>
        <form id="aiadmin-trust-schedule-form">
          <div class="ai-admin-row">
            <label for="trust-schedule-enabled">' . $this->msgHtml('aiadmin-field-scheduled') . '</label>
            <input type="checkbox" id="trust-schedule-enabled" />
            <label for="trust-schedule-interval">' . $this->msgHtml('aiadmin-field-interval-min') . '</label>
            <input type="number" id="trust-schedule-interval" value="1440" min="5" max="10080" />
            <label for="trust-schedule-maxscan">' . $this->msgHtml('aiadmin-field-max-scan') . '</label>
            <input type="number" id="trust-schedule-maxscan" value="1000" min="1" max="100000" />
            <label for="trust-schedule-batchsize">' . $this->msgHtml('aiadmin-field-batch-size') . '</label>
            <input type="number" id="trust-schedule-batchsize" value="128" min="1" max="500" />
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-save-trust-schedule">' . $this->msgHtml('aiadmin-action-save-scheduled-recalculation') . '</button>
          <span id="aiadmin-trust-schedule-status"></span>
        </form>
        <div id="aiadmin-trust-schedule-result" class="ai-admin-muted"></div>
        <div class="ai-admin-muted">' . htmlspecialchars($this->msg('aiadmin-trust-note')->text()) . '</div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="webhook">
        <h2>' . htmlspecialchars($this->msg('aiadmin-webhook')->text()) . '</h2>
        <form id="aiadmin-webhook-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-webhook-config">' . htmlspecialchars($this->msg('aiadmin-save')->text()) . '</button>
        <button type="button" class="ai-admin-btn" id="aiadmin-test-webhook-config">' . $this->msgHtml('aiadmin-action-test') . '</button>
        <span id="aiadmin-webhook-status"></span>
        <div id="aiadmin-webhook-test" class="ai-admin-search-results"></div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="ontology">
        <h2>' . htmlspecialchars($this->msg('aiadmin-semantics')->text()) . '</h2>
        <div class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-ontology-actions') . '</div>
        <div id="aiadmin-ontology-properties">' . $this->msgHtml('aiadmin-loading-ontology') . '</div>
        <form id="aiadmin-ontology-form">
          <div class="ai-admin-row">
            <label for="ontology-name">' . $this->msgHtml('aiadmin-field-smw-property') . '</label>
            <select id="ontology-name"></select>
            <span id="ontology-derived-summary" class="ai-admin-muted"></span>
          </div>
          <div class="ai-admin-row">
            <input type="text" id="ontology-smw-search" placeholder="' . $this->msgHtml('aiadmin-placeholder-search-smw-property') . '" />
            <button type="button" class="ai-admin-btn" id="aiadmin-search-smw-properties">' . $this->msgHtml('aiadmin-action-search-smw-properties') . '</button>
            <button type="button" class="ai-admin-btn" id="aiadmin-load-more-smw-properties">' . $this->msgHtml('aiadmin-action-load-more') . '</button>
            <span id="aiadmin-smw-properties-status" class="ai-admin-muted"></span>
          </div>
          <div class="ai-admin-row">
            <label for="ontology-description">' . $this->msgHtml('aiadmin-field-description') . '</label>
            <textarea id="ontology-description"></textarea>
            <label for="ontology-prompt">' . $this->msgHtml('aiadmin-field-ai-prompt-hint') . '</label>
            <textarea id="ontology-prompt"></textarea>
          </div>
          <div class="ai-admin-row">
            <label for="ontology-threshold">' . $this->msgHtml('aiadmin-field-threshold') . '</label>
            <input type="number" id="ontology-threshold" value="0.7" min="0" max="1" step="0.01" />
            <label for="ontology-indexed">' . $this->msgHtml('aiadmin-field-indexed') . '</label>
            <input type="checkbox" id="ontology-indexed" checked />
            <label for="ontology-extractable">' . $this->msgHtml('aiadmin-field-ai-extractable') . '</label>
            <input type="checkbox" id="ontology-extractable" checked />
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-add-ontology">' . $this->msgHtml('aiadmin-action-add-ontology') . '</button>
          <button type="button" class="ai-admin-btn" id="aiadmin-save-ontology">' . $this->msgHtml('aiadmin-action-save-ontology') . '</button>
          <button type="button" class="ai-admin-btn" id="aiadmin-generate-ontology-vector">' . $this->msgHtml('aiadmin-action-generate-vector') . '</button>
          <button type="button" class="ai-admin-btn" id="aiadmin-similar-ontology">' . $this->msgHtml('aiadmin-action-similar') . '</button>
          <button type="button" class="ai-admin-btn" id="aiadmin-clusterize-ontology">' . $this->msgHtml('aiadmin-action-clusterize') . '</button>
          <button type="button" class="ai-admin-btn ai-admin-btn-danger" id="aiadmin-delete-ontology">' . $this->msgHtml('aiadmin-action-delete') . '</button>
          <span id="aiadmin-ontology-status"></span>
          <div class="ai-admin-row">
            <label for="ontology-fragment">' . $this->msgHtml('aiadmin-field-fragment') . '</label>
            <textarea id="ontology-fragment" placeholder="' . $this->msgHtml('aiadmin-placeholder-document-fragment') . '"></textarea>
            <label for="ontology-classify-threshold">' . $this->msgHtml('aiadmin-field-classify-threshold') . '</label>
            <input type="number" id="ontology-classify-threshold" value="0.7" min="0" max="1" step="0.01" />
            <label for="ontology-include-sensitive">' . $this->msgHtml('aiadmin-field-include-sensitive') . '</label>
            <input type="checkbox" id="ontology-include-sensitive" />
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-classify-ontology-fragment">' . $this->msgHtml('aiadmin-action-classify-fragment') . '</button>
        </form>
        <div id="aiadmin-ontology-result" class="ai-admin-search-results"></div>
        <div id="aiadmin-semantic-status">' . $this->msgHtml('aiadmin-loading') . '</div>
        <div class="ai-admin-row">
          <input type="text" id="aiadmin-semantic-property" placeholder="Департамент" value="Департамент" />
          <input type="text" id="aiadmin-semantic-value" placeholder="ИТ департамент" />
          <input type="number" id="aiadmin-semantic-namespace" placeholder="namespace" />
          <button type="button" class="ai-admin-btn" id="aiadmin-semantic-search-btn">' . $this->msgHtml('aiadmin-action-search-facts') . '</button>
          <button type="button" class="ai-admin-btn" id="aiadmin-semantic-refresh">' . $this->msgHtml('aiadmin-action-refresh-status') . '</button>
        </div>
        <div class="ai-admin-muted">' . htmlspecialchars($this->msg('aiadmin-semantics-note')->text()) . '</div>
        <div id="aiadmin-semantic-search" class="ai-admin-search-results"></div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="autofill">
        <h2>' . htmlspecialchars($this->msg('aiadmin-autofill')->text()) . '</h2>
        <form id="aiadmin-autofill-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-autofill-config">' . $this->msgHtml('aiadmin-save') . '</button>
        <button type="button" class="ai-admin-btn" id="aiadmin-refresh-autofill-status">' . $this->msgHtml('aiadmin-action-refresh-status') . '</button>
        <span id="aiadmin-autofill-status"></span>
        <div id="aiadmin-autofill-summary" class="ai-admin-muted"></div>
        <div id="aiadmin-autofill-fields" class="ai-admin-search-results">' . $this->msgHtml('aiadmin-loading') . '</div>
        <div class="ai-admin-muted">' . htmlspecialchars($this->msg('aiadmin-autofill-note')->text()) . '</div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="sensitive">
        <h2>' . $this->msgHtml('aiadmin-tab-sensitive') . '</h2>
        <div class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-sensitive-properties') . '</div>
        <div id="aiadmin-sensitive-properties">' . $this->msgHtml('aiadmin-loading-ontology') . '</div>
        <button type="button" class="ai-admin-btn" id="aiadmin-refresh-sensitive-properties">' . $this->msgHtml('aiadmin-action-refresh') . '</button>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-sensitive-properties">' . $this->msgHtml('aiadmin-action-save-sensitive-properties') . '</button>
        <span id="aiadmin-sensitive-status"></span>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="indexing">
        <h2>' . htmlspecialchars($this->msg('aiadmin-management')->text()) . '</h2>
        <div id="aiadmin-indexing-profiles">' . $this->msgHtml('aiadmin-loading') . '</div>
        <div id="aiadmin-indexing-scheduler" class="ai-admin-search-results">' . $this->msgHtml('aiadmin-loading-scheduler') . '</div>
        <form id="aiadmin-indexing-profile-form">
          <div class="ai-admin-row">
            <label for="idx-profile-id">' . $this->msgHtml('aiadmin-field-profile-id') . '</label>
            <input type="text" id="idx-profile-id" placeholder="corp-it" />
            <label for="idx-profile-name">' . $this->msgHtml('aiadmin-field-name') . '</label>
            <input type="text" id="idx-profile-name" placeholder="ИТ документы" />
          </div>
          <div class="ai-admin-row">
            <label for="idx-profile-namespaces">' . $this->msgHtml('aiadmin-field-namespaces-csv') . '</label>
            <input type="text" id="idx-profile-namespaces" placeholder="3030,3000" />
            <label for="idx-profile-maxpages">' . $this->msgHtml('aiadmin-field-default-max-pages') . '</label>
            <input type="number" id="idx-profile-maxpages" min="1" placeholder="' . $this->msgHtml('aiadmin-placeholder-optional') . '" />
          </div>
          <div class="ai-admin-row">
            <label for="idx-profile-chunksize">' . $this->msgHtml('aiadmin-field-chunk-size') . '</label>
            <input type="number" id="idx-profile-chunksize" min="128" max="4096" />
            <label for="idx-profile-overlap">' . $this->msgHtml('aiadmin-field-chunk-overlap') . '</label>
            <input type="number" id="idx-profile-overlap" min="0" max="2048" />
          </div>
          <div class="ai-admin-row">
            <label for="idx-profile-properties">' . $this->msgHtml('aiadmin-field-smw-properties-csv') . '</label>
            <div id="idx-profile-properties" class="ai-admin-muted"></div>
          </div>
          <div class="ai-admin-row">
            <div class="ai-admin-field">
              <label for="idx-profile-title-include">' . $this->msgHtml('aiadmin-field-title-include-csv') . '</label>
              <input type="text" id="idx-profile-title-include" placeholder="CorpIT:,Регламент" />
              <div class="ai-admin-muted" id="idx-profile-title-include-help">' . $this->msgHtml('aiadmin-help-title-include-filter') . '</div>
            </div>
            <div class="ai-admin-field">
              <label for="idx-profile-title-exclude">' . $this->msgHtml('aiadmin-field-title-exclude-csv') . '</label>
              <input type="text" id="idx-profile-title-exclude" placeholder="Черновик,Архив" />
              <div class="ai-admin-muted" id="idx-profile-title-exclude-help">' . $this->msgHtml('aiadmin-help-title-exclude-filter') . '</div>
            </div>
          </div>
          <div class="ai-admin-row">
            <div class="ai-admin-field">
              <label for="idx-profile-category-include-search">' . $this->msgHtml('aiadmin-field-category-include-csv') . '</label>
              <input type="hidden" id="idx-profile-category-include" />
              <div class="ai-admin-category-controls">
                <input type="search" id="idx-profile-category-include-search" list="idx-profile-category-options" placeholder="ИТ" />
                <button type="button" class="ai-admin-btn" id="idx-profile-category-include-add">' . $this->msgHtml('aiadmin-action-add-filter-value') . '</button>
              </div>
              <div class="ai-admin-muted" id="idx-profile-category-include-available">' . $this->msgHtml('aiadmin-label-available-categories') . '</div>
              <select id="idx-profile-category-include-select" class="ai-admin-category-select" size="6"></select>
              <div id="idx-profile-category-include-chips" class="ai-admin-chip-list"></div>
              <div class="ai-admin-muted" id="idx-profile-category-include-help">' . $this->msgHtml('aiadmin-help-category-include-filter') . '</div>
            </div>
            <div class="ai-admin-field">
              <label for="idx-profile-category-exclude-search">' . $this->msgHtml('aiadmin-field-category-exclude-csv') . '</label>
              <input type="hidden" id="idx-profile-category-exclude" />
              <div class="ai-admin-category-controls">
                <input type="search" id="idx-profile-category-exclude-search" list="idx-profile-category-options" placeholder="Архив" />
                <button type="button" class="ai-admin-btn" id="idx-profile-category-exclude-add">' . $this->msgHtml('aiadmin-action-add-filter-value') . '</button>
              </div>
              <div class="ai-admin-muted" id="idx-profile-category-exclude-available">' . $this->msgHtml('aiadmin-label-available-categories') . '</div>
              <select id="idx-profile-category-exclude-select" class="ai-admin-category-select" size="6"></select>
              <div id="idx-profile-category-exclude-chips" class="ai-admin-chip-list"></div>
              <div class="ai-admin-muted" id="idx-profile-category-exclude-help">' . $this->msgHtml('aiadmin-help-category-exclude-filter') . '</div>
            </div>
            <datalist id="idx-profile-category-options"></datalist>
          </div>
          <div class="ai-admin-row">
            <label for="idx-profile-document-policy">' . $this->msgHtml('aiadmin-field-document-policy') . '</label>
            <input type="text" id="idx-profile-document-policy" value="default" />
            <label for="idx-profile-runmode">' . $this->msgHtml('aiadmin-field-run-mode') . '</label>
            <select id="idx-profile-runmode">
              <option value="manual">manual</option>
              <option value="scheduled">scheduled</option>
            </select>
            <label for="idx-profile-schedule">' . $this->msgHtml('aiadmin-field-schedule-min') . '</label>
            <input type="number" id="idx-profile-schedule" min="5" max="10080" placeholder="' . $this->msgHtml('aiadmin-placeholder-optional') . '" />
          </div>
          <div class="ai-admin-row">
            <label for="idx-profile-attachments">' . $this->msgHtml('aiadmin-field-attachments') . '</label>
            <input type="checkbox" id="idx-profile-attachments" />
            <label for="idx-profile-semantics">' . $this->msgHtml('aiadmin-field-semantic-facts') . '</label>
            <input type="checkbox" id="idx-profile-semantics" checked />
            <label for="idx-profile-dryrun">' . $this->msgHtml('aiadmin-field-dry-run-default') . '</label>
            <input type="checkbox" id="idx-profile-dryrun" />
          </div>
          <button type="button" class="ai-admin-btn" id="aiadmin-save-indexing-profile">' . $this->msgHtml('aiadmin-action-save-profile') . '</button>
          <span id="aiadmin-indexing-profile-status"></span>
        </form>
        <div class="ai-admin-row">
          <label for="aiadmin-reindex-profile">' . $this->msgHtml('aiadmin-field-profile') . '</label>
          <select id="aiadmin-reindex-profile"></select>
          <label for="aiadmin-reindex-maxpages">' . $this->msgHtml('aiadmin-field-max-pages') . '</label>
          <input type="number" id="aiadmin-reindex-maxpages" min="1" placeholder="' . $this->msgHtml('aiadmin-placeholder-optional') . '" />
          <label for="aiadmin-reindex-attachments">' . $this->msgHtml('aiadmin-field-attachments') . '</label>
          <input type="checkbox" id="aiadmin-reindex-attachments" />
          <label for="aiadmin-reindex-dryrun">' . $this->msgHtml('aiadmin-field-dry-run') . '</label>
          <input type="checkbox" id="aiadmin-reindex-dryrun" />
          <label for="aiadmin-reindex-llm-enrichment">' . $this->msgHtml('aiadmin-field-reindex-llm-enrichment') . '</label>
          <input type="checkbox" id="aiadmin-reindex-llm-enrichment" />
        </div>
        <div class="ai-admin-row">
          <label for="aiadmin-reindex-llm-model">' . $this->msgHtml('aiadmin-field-reindex-llm-model') . '</label>
          <input type="text" id="aiadmin-reindex-llm-model" placeholder="' . $this->msgHtml('aiadmin-placeholder-current-llm-model') . '" />
          <label for="aiadmin-reindex-llm-maxchars">' . $this->msgHtml('aiadmin-field-reindex-llm-max-chars') . '</label>
          <input type="number" id="aiadmin-reindex-llm-maxchars" min="1000" max="50000" value="8000" />
        </div>
        <div class="ai-admin-muted" id="aiadmin-reindex-maxpages-help">' . $this->msgHtml('aiadmin-help-reindex-max-pages') . '</div>
        <div class="ai-admin-muted">' . $this->msgHtml('aiadmin-help-reindex-llm-enrichment') . '</div>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-start-reindex">' . htmlspecialchars($this->msg('aiadmin-sync-now')->text()) . '</button>
        <button type="button" class="ai-admin-btn ai-admin-btn-danger" id="aiadmin-clear-cache">' . htmlspecialchars($this->msg('aiadmin-clear-cache')->text()) . '</button>
        <button type="button" class="ai-admin-btn" disabled>' . htmlspecialchars($this->msg('aiadmin-backup')->text()) . '</button>
        <button type="button" class="ai-admin-btn ai-admin-btn-danger" disabled>' . htmlspecialchars($this->msg('aiadmin-purge')->text()) . '</button>
        <div class="ai-admin-muted">' . htmlspecialchars($this->msg('aiadmin-management-note')->text()) . '</div>
        <div id="aiadmin-reindex-status"></div>
        <div id="aiadmin-management-status"></div>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="audit">
        <h2>' . htmlspecialchars($this->msg('aiadmin-audit')->text()) . '</h2>
        <button type="button" class="ai-admin-btn" id="aiadmin-refresh-audit">' . $this->msgHtml('aiadmin-action-refresh') . '</button>
        <div id="aiadmin-audit-log" class="ai-admin-search-results">' . $this->msgHtml('aiadmin-loading') . '</div>
      </div>
    </div>';
  }

  private function getAdminScript(string $apiBase, string $mediaWikiSyncerUrl, bool $adminProxyEnabled): string
  {
    return '<script>
    (() => {
      const apiBase = ' . json_encode($apiBase) . ';
      const mediaWikiSyncerUrl = ' . json_encode($mediaWikiSyncerUrl) . ';
      const adminProxyEnabled = ' . json_encode($adminProxyEnabled) . ';
      const i18n = ' . json_encode($this->getAdminI18nMessages(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ';
      let documentPolicy = { attachmentsEnabled: true, mimeTypes: {} };
      let serviceConfig = null;
      let externalApiConfig = null;
      let llmConfig = null;
      let embeddingConfig = null;
      let ragConfig = null;
      let webhookConfig = null;
      let chatRetentionConfig = null;
      let semanticAutofillConfig = null;
      let conflictDetectionConfig = null;
      let trustModels = [];
      let trustEntities = [];
      let trustRules = [];
      let trustPolicyRows = [];
      let activeTrustModelId = null;
      let selectedTrustEntityId = null;
      let selectedTrustRuleId = null;
      let selectedTrustPolicyRowId = null;
      let trustEntitySort = { key: "name", direction: "asc" };
      let trustRuleSort = { key: "displayOrder", direction: "asc" };
      let trustPolicySort = { key: "displayOrder", direction: "asc" };
      const defaultTrustRuleFlags = ["verified", "official", "draft", "outdated", "sensitive", "manual-review"];
      const ontologyPropertyTemplates = {
        "Департамент": {
          id: "department",
          label: "Департамент",
          description: "Организационный департамент, к которому относится документ или процесс.",
          prompt: "Определяй департамент по явным упоминаниям подразделений: HR, ИТ, Финансы, Юридический блок, Операции. Не угадывай департамент без прямого признака.",
        },
        "Отдел": {
          id: "department-unit",
          label: "Отдел",
          description: "Более точная организационная ветка внутри департамента.",
          prompt: "Извлекай отдел только если он явно указан в документе, названии страницы, шаблоне или SMW-свойстве.",
        },
        "Тип документа": {
          id: "document-type",
          label: "Тип документа",
          description: "Класс документа: регламент, инструкция, FAQ, приказ, политика, процедура.",
          prompt: "Классифицируй тип документа по назначению текста и служебным признакам. Используй короткие устойчивые значения.",
        },
        "Владелец процесса": {
          id: "process-owner",
          label: "Владелец процесса",
          description: "Роль или подразделение, ответственное за процесс и актуальность документа.",
          prompt: "Ищи владельца процесса в реквизитах, ответственных ролях, шаблонах согласования и блоках администрирования.",
        },
        "Статус документа": {
          id: "document-status",
          label: "Статус документа",
          description: "Жизненный статус документа: черновик, утвержден, архив, требует проверки.",
          prompt: "Определяй статус только по явным словам статуса или служебным полям. Не считай документ утвержденным без признака утверждения.",
        },
        "Система": {
          id: "system",
          label: "Система",
          description: "Информационная система, сервис или продукт, к которому относится документ.",
          prompt: "Извлекай название системы из заголовков, категорий, шаблонов, инструкций и технических терминов.",
        },
        "Процесс": {
          id: "process",
          label: "Процесс",
          description: "Бизнес-процесс или операционная процедура, которую описывает документ.",
          prompt: "Выделяй процесс как короткое название действия или цепочки работ: прием сотрудника, доступ VPN, закрытие месяца.",
        },
        "Дата действия": {
          id: "effective-date",
          label: "Дата действия",
          description: "Дата вступления документа или правила в силу.",
          prompt: "Извлекай дату действия только из реквизитов, приказов, блоков \"действует с\" или аналогичных явных формулировок.",
        },
        "Критичность": {
          id: "criticality",
          label: "Критичность",
          description: "Важность документа или процесса для бизнеса и безопасности.",
          prompt: "Оценивай критичность по явным признакам: безопасность, доступы, финансы, персональные данные, остановка сервиса.",
        },
      };
      let ontologyProperties = [];
      let smwPropertyCatalog = [];
      let smwPropertyCatalogLoaded = false;
      let smwPropertyCatalogNextContinue = null;
      let smwPropertyCatalogSearch = "";
      let selectedOntologyPropertyId = null;
      let semanticPropertyValues = {};
      let semanticPropertyValuesLoaded = false;
      let indexingProfiles = [];
      let categoryOptionsTimer = null;
      let categoryOptions = [];
      let wikiReferenceTimers = {};
      let namespaceOptions = [];
      let userGroupOptions = [];
      let tagOptions = [];
      let templateOptions = [];
      let pageOptions = [];

      const t = (key, fallback = key) => i18n[key] || fallback;
      const formatText = (key, values = {}, fallback = key) => Object.entries(values)
        .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value ?? "")), t(key, fallback));
      const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);
      const yesNo = (value) => value ? t("aiadmin-value-yes") : t("aiadmin-value-no");
      const unknown = () => t("aiadmin-value-unknown");
      const tableHtml = (keys) => `<thead><tr>${keys.map((key) => `<th>${t(key)}</th>`).join("")}</tr></thead><tbody></tbody>`;
      const compareValues = (left, right) => {
        if (typeof left === "number" || typeof right === "number") return Number(left ?? 0) - Number(right ?? 0);
        if (typeof left === "boolean" || typeof right === "boolean") return Number(Boolean(left)) - Number(Boolean(right));
        return String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true, sensitivity: "base" });
      };
      const sortedRows = (rows, sortState, valueReader) => [...rows].sort((left, right) => {
        const result = compareValues(valueReader(left, sortState.key), valueReader(right, sortState.key));
        return sortState.direction === "asc" ? result : -result;
      });
      const appendSortableHeader = (row, column, sortState, onSort) => {
        const th = document.createElement("th");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ai-admin-sort-button";
        const sorted = sortState.key === column.key;
        button.textContent = `${t(column.label)}${sorted ? (sortState.direction === "asc" ? " ▲" : " ▼") : ""}`;
        button.addEventListener("click", () => onSort(column.key));
        th.appendChild(button);
        row.appendChild(th);
      };
      const appendTableCell = (row, value) => {
        const cell = document.createElement("td");
        cell.textContent = String(value ?? "");
        row.appendChild(cell);
        return cell;
      };
      const endpoint = (path) => {
        if (!adminProxyEnabled) return `${apiBase}${path}`;
        const url = new URL(window.location.href);
        url.searchParams.set("aiadmin-proxy", "1");
        url.searchParams.set("path", path);
        return url.toString();
      };
      const normalizeServiceUrl = (value) => {
        const raw = String(value || "").trim();
        if (!raw) return "";
        try {
          const url = new URL(raw);
          url.pathname = url.pathname.replace(/\/+$/, "");
          if (url.pathname === "/") url.pathname = "";
          url.search = "";
          url.hash = "";
          return url.toString().replace(/\/+$/, "");
        } catch (_err) {
          return raw.replace(/\/+$/, "");
        }
      };
      const statusText = (id, message, ok = true) => {
        const node = document.getElementById(id);
        if (!node) return;
        node.textContent = message;
        node.className = ok ? "ai-admin-status-ok" : "ai-admin-status-error";
      };
      const showStartupError = (message) => {
        const root = document.getElementById("aiadmin-health");
        if (!root) return;
        if ((root.textContent || "").trim() !== t("aiadmin-loading")) return;
        root.textContent = message;
        root.className = "ai-admin-status-error";
      };
      window.addEventListener("error", (event) => {
        showStartupError(`AI-admin JS error: ${event.message || "unknown error"}`);
      });
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        const message = reason instanceof Error ? reason.message : String(reason || "unknown error");
        showStartupError(`AI-admin async error: ${message}`);
      });
      const activateTab = (name) => {
        document.querySelectorAll(".ai-admin-tab").forEach((tab) => {
          tab.classList.toggle("active", tab.dataset.aiTab === name);
        });
        document.querySelectorAll(".ai-admin-panel").forEach((panel) => {
          panel.classList.toggle("active", panel.dataset.aiPanel === name);
        });
      };
      const initializeTabs = () => {
        document.querySelectorAll(".ai-admin-tab").forEach((tab) => {
          tab.addEventListener("click", () => activateTab(tab.dataset.aiTab));
        });
      };
      const applyStaticTranslations = () => {
        const textMap = [
          ["#aiadmin-test-webhook-config", "aiadmin-action-test"],
          ["#aiadmin-save-trust-model", "aiadmin-action-save-model"],
          ["#aiadmin-add-trust-entity", "aiadmin-action-add-entity"],
          ["#aiadmin-save-trust-entity", "aiadmin-action-save-entity"],
          ["#aiadmin-delete-trust-entity", "aiadmin-action-delete"],
          ["#aiadmin-add-trust-rule", "aiadmin-action-add-rule"],
          ["#aiadmin-save-trust-rule", "aiadmin-action-save-rule"],
          ["#aiadmin-delete-trust-rule", "aiadmin-action-delete"],
          ["#aiadmin-add-trust-rule-flag", "aiadmin-action-add-flag"],
          ["#aiadmin-run-trust-preview", "aiadmin-action-preview"],
          ["#trust-preview-categories-add", "aiadmin-action-add-filter-value"],
          ["#trust-preview-tags-add", "aiadmin-action-add-filter-value"],
          ["#trust-preview-author-groups-add", "aiadmin-action-add-filter-value"],
          ["#trust-preview-templates-add", "aiadmin-action-add-filter-value"],
          ["#aiadmin-run-trust-recalc", "aiadmin-action-recalculate-trust-payload"],
          ["#aiadmin-save-trust-schedule", "aiadmin-action-save-scheduled-recalculation"],
          ["#aiadmin-save-webhook-config", "aiadmin-save"],
          ["#aiadmin-save-autofill-config", "aiadmin-save"],
          ["#aiadmin-refresh-autofill-status", "aiadmin-action-refresh-status"],
          ["#aiadmin-add-ontology", "aiadmin-action-add-ontology"],
          ["#aiadmin-save-ontology", "aiadmin-action-save-ontology"],
          ["#aiadmin-generate-ontology-vector", "aiadmin-action-generate-vector"],
          ["#aiadmin-similar-ontology", "aiadmin-action-similar"],
          ["#aiadmin-clusterize-ontology", "aiadmin-action-clusterize"],
          ["#aiadmin-delete-ontology", "aiadmin-action-delete"],
          ["#aiadmin-classify-ontology-fragment", "aiadmin-action-classify-fragment"],
          ["#aiadmin-semantic-search-btn", "aiadmin-action-search-facts"],
          ["#aiadmin-semantic-refresh", "aiadmin-action-refresh-status"],
          ["#aiadmin-save-indexing-profile", "aiadmin-action-save-profile"],
          ["#aiadmin-refresh-audit", "aiadmin-action-refresh"],
          ["label[for=\"trust-model-id\"]", "aiadmin-field-model-id"],
          ["label[for=\"trust-model-name\"]", "aiadmin-field-name"],
          ["label[for=\"trust-base-score\"]", "aiadmin-field-base-score"],
          ["label[for=\"trust-min-context\"]", "aiadmin-field-min-context-score"],
          ["label[for=\"trust-model-active\"]", "aiadmin-field-active"],
          ["label[for=\"trust-include-drafts\"]", "aiadmin-field-include-drafts"],
          ["label[for=\"trust-staleness-penalty\"]", "aiadmin-field-staleness-penalty-per-year"],
          ["label[for=\"trust-require-verified\"]", "aiadmin-field-require-verified-direct-answer"],
          ["label[for=\"trust-require-sources\"]", "aiadmin-field-require-sources"],
          ["label[for=\"trust-entity-id\"]", "aiadmin-field-entity-id"],
          ["label[for=\"trust-entity-type\"]", "aiadmin-field-entity-type"],
          ["label[for=\"trust-entity-name\"]", "aiadmin-field-name"],
          ["label[for=\"trust-entity-value\"]", "aiadmin-field-value"],
          ["label[for=\"trust-entity-weight\"]", "aiadmin-field-weight"],
          ["label[for=\"trust-entity-enabled\"]", "aiadmin-field-enabled"],
          ["label[for=\"trust-rule-id\"]", "aiadmin-field-rule-id"],
          ["label[for=\"trust-rule-name\"]", "aiadmin-field-name"],
          ["label[for=\"trust-rule-modifier\"]", "aiadmin-field-modifier"],
          ["label[for=\"trust-rule-field\"]", "aiadmin-field-field"],
          ["label[for=\"trust-rule-operator\"]", "aiadmin-field-operator"],
          ["label[for=\"trust-rule-property\"]", "aiadmin-field-property-name"],
          ["label[for=\"trust-rule-value\"]", "aiadmin-field-value"],
          ["label[for=\"trust-rule-new-flag\"]", "aiadmin-field-flags-csv"],
          ["label[for=\"trust-rule-order\"]", "aiadmin-field-display-order"],
          ["label[for=\"trust-rule-enabled\"]", "aiadmin-field-enabled"],
          ["label[for=\"trust-rule-exclude\"]", "aiadmin-field-exclude-from-index"],
          ["label[for=\"trust-rule-manual\"]", "aiadmin-field-manual-approval"],
          ["label[for=\"trust-rule-notify\"]", "aiadmin-field-notify-author"],
          ["label[for=\"trust-preview-title\"]", "aiadmin-field-title"],
          ["label[for=\"trust-preview-namespace\"]", "aiadmin-field-namespace"],
          ["label[for=\"trust-preview-categories-search\"]", "aiadmin-field-categories-csv"],
          ["label[for=\"trust-preview-tags-search\"]", "aiadmin-field-tags-csv"],
          ["label[for=\"trust-preview-author-groups-search\"]", "aiadmin-field-author-groups-csv"],
          ["label[for=\"trust-preview-templates-search\"]", "aiadmin-field-templates-csv"],
          ["label[for=\"trust-preview-last-modified\"]", "aiadmin-field-last-modified"],
          ["label[for=\"trust-preview-properties\"]", "aiadmin-field-properties-json"],
          ["label[for=\"trust-recalc-maxscan\"]", "aiadmin-field-max-scan"],
          ["label[for=\"trust-recalc-batchsize\"]", "aiadmin-field-batch-size"],
          ["label[for=\"trust-recalc-dryrun\"]", "aiadmin-field-dry-run"],
          ["label[for=\"trust-schedule-enabled\"]", "aiadmin-field-scheduled"],
          ["label[for=\"trust-schedule-interval\"]", "aiadmin-field-interval-min"],
          ["label[for=\"trust-schedule-maxscan\"]", "aiadmin-field-max-scan"],
          ["label[for=\"trust-schedule-batchsize\"]", "aiadmin-field-batch-size"],
          ["label[for=\"ontology-name\"]", "aiadmin-field-smw-property"],
          ["label[for=\"ontology-description\"]", "aiadmin-field-description"],
          ["label[for=\"ontology-prompt\"]", "aiadmin-field-ai-prompt-hint"],
          ["label[for=\"ontology-threshold\"]", "aiadmin-field-threshold"],
          ["label[for=\"ontology-extractable\"]", "aiadmin-field-ai-extractable"],
          ["label[for=\"ontology-fragment\"]", "aiadmin-field-fragment"],
          ["label[for=\"ontology-classify-threshold\"]", "aiadmin-field-classify-threshold"],
          ["label[for=\"ontology-include-sensitive\"]", "aiadmin-field-include-sensitive"],
          ["label[for=\"idx-profile-id\"]", "aiadmin-field-profile-id"],
          ["label[for=\"idx-profile-name\"]", "aiadmin-field-name"],
          ["label[for=\"idx-profile-namespaces\"]", "aiadmin-field-namespaces-csv"],
          ["label[for=\"idx-profile-maxpages\"]", "aiadmin-field-default-max-pages"],
          ["label[for=\"idx-profile-chunksize\"]", "aiadmin-field-chunk-size"],
          ["label[for=\"idx-profile-overlap\"]", "aiadmin-field-chunk-overlap"],
          ["label[for=\"idx-profile-properties\"]", "aiadmin-field-smw-properties-csv"],
          ["label[for=\"idx-profile-title-include\"]", "aiadmin-field-title-include-csv"],
          ["label[for=\"idx-profile-title-exclude\"]", "aiadmin-field-title-exclude-csv"],
          ["label[for=\"idx-profile-category-include-search\"]", "aiadmin-field-category-include-csv"],
          ["label[for=\"idx-profile-category-exclude-search\"]", "aiadmin-field-category-exclude-csv"],
          ["#idx-profile-title-include-help", "aiadmin-help-title-include-filter"],
          ["#idx-profile-title-exclude-help", "aiadmin-help-title-exclude-filter"],
          ["#idx-profile-category-include-help", "aiadmin-help-category-include-filter"],
          ["#idx-profile-category-exclude-help", "aiadmin-help-category-exclude-filter"],
          ["#idx-profile-category-include-available", "aiadmin-label-available-categories"],
          ["#idx-profile-category-exclude-available", "aiadmin-label-available-categories"],
          ["#idx-profile-category-include-add", "aiadmin-action-add-filter-value"],
          ["#idx-profile-category-exclude-add", "aiadmin-action-add-filter-value"],
          ["label[for=\"idx-profile-document-policy\"]", "aiadmin-field-document-policy"],
          ["label[for=\"idx-profile-runmode\"]", "aiadmin-field-run-mode"],
          ["label[for=\"idx-profile-schedule\"]", "aiadmin-field-schedule-min"],
          ["label[for=\"idx-profile-attachments\"]", "aiadmin-field-attachments"],
          ["label[for=\"idx-profile-semantics\"]", "aiadmin-field-semantic-facts"],
          ["label[for=\"idx-profile-dryrun\"]", "aiadmin-field-dry-run-default"],
          ["label[for=\"aiadmin-reindex-profile\"]", "aiadmin-field-profile"],
          ["label[for=\"aiadmin-reindex-maxpages\"]", "aiadmin-field-max-pages"],
          ["label[for=\"aiadmin-reindex-attachments\"]", "aiadmin-field-attachments"],
          ["label[for=\"aiadmin-reindex-dryrun\"]", "aiadmin-field-dry-run"],
          ["#aiadmin-trust-rule-condition-help", "aiadmin-help-trust-rule-condition"],
          ["#aiadmin-trust-rule-flags-help", "aiadmin-help-trust-rule-flags"],
        ];
        textMap.forEach(([selector, key]) => {
          const node = document.querySelector(selector);
          if (node) node.textContent = t(key);
        });

        const placeholderMap = [
          ["#ontology-fragment", "aiadmin-placeholder-document-fragment"],
          ["#idx-profile-maxpages", "aiadmin-placeholder-optional"],
          ["#idx-profile-schedule", "aiadmin-placeholder-optional"],
          ["#aiadmin-reindex-maxpages", "aiadmin-placeholder-optional"],
          ["#aiadmin-reindex-llm-model", "aiadmin-placeholder-current-llm-model"],
          ["#trust-model-name", "aiadmin-placeholder-corporate-default"],
          ["#trust-entity-name", "aiadmin-placeholder-verified-documents"],
        ];
        placeholderMap.forEach(([selector, key]) => {
          const node = document.querySelector(selector);
          if (node) node.placeholder = t(key);
        });
      };
      const appendInputRow = (form, id, label, value, options = {}) => {
        const row = document.createElement("div");
        row.className = "ai-admin-row";
        const labelNode = document.createElement("label");
        labelNode.htmlFor = id;
        labelNode.textContent = label;
        let input;
        if (options.textarea) {
          input = document.createElement("textarea");
        } else {
          input = document.createElement("input");
          input.type = options.type || "text";
        }
        input.id = id;
        input.name = id;
        input.value = value ?? "";
        if (options.readonly) input.readOnly = true;
        if (options.min !== undefined) input.min = String(options.min);
        if (options.max !== undefined) input.max = String(options.max);
        if (options.step !== undefined) input.step = String(options.step);
        row.append(labelNode, input);
        form.appendChild(row);
        return input;
      };
      const appendCheckboxRow = (form, id, label, checked) => {
        const row = document.createElement("div");
        row.className = "ai-admin-row";
        const labelNode = document.createElement("label");
        labelNode.htmlFor = id;
        labelNode.textContent = label;
        const input = document.createElement("input");
        input.id = id;
        input.name = id;
        input.type = "checkbox";
        input.checked = Boolean(checked);
        row.append(labelNode, input);
        form.appendChild(row);
        return input;
      };
      const appendSelectRow = (form, id, label, value, options) => {
        const row = document.createElement("div");
        row.className = "ai-admin-row";
        const labelNode = document.createElement("label");
        labelNode.htmlFor = id;
        labelNode.textContent = label;
        const select = document.createElement("select");
        select.id = id;
        select.name = id;
        options.forEach((item) => {
          const optionValue = Array.isArray(item) ? item[0] : item.value;
          const optionLabel = Array.isArray(item) ? item[1] : item.label;
          const option = document.createElement("option");
          option.value = optionValue;
          option.textContent = optionLabel;
          option.selected = optionValue === value;
          select.appendChild(option);
        });
        const firstOption = options[0];
        select.value = value ?? (Array.isArray(firstOption) ? firstOption[0] : firstOption?.value) ?? "";
        row.append(labelNode, select);
        form.appendChild(row);
        return select;
      };
      const request = async (path, options = {}) => {
        const {
          headers = {},
          timeoutMs = 15000,
          signal: _signal,
          ...fetchOptions
        } = options;
        const controller = new AbortController();
        const timeoutId = timeoutMs > 0
          ? window.setTimeout(() => controller.abort(), timeoutMs)
          : null;
        const requestHeaders = { ...headers };
        const hasBody = fetchOptions.body !== undefined && fetchOptions.body !== null && fetchOptions.body !== "";
        const hasContentType = Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type");
        if (hasBody && !hasContentType) {
          requestHeaders["Content-Type"] = "application/json";
        }
        try {
          const res = await fetch(endpoint(path), {
            ...fetchOptions,
            credentials: "include",
            headers: requestHeaders,
            signal: controller.signal,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
          return data;
        } catch (err) {
          if (err?.name === "AbortError") {
            throw new Error(formatText("aiadmin-error-request-timeout", {
              seconds: Math.ceil(timeoutMs / 1000),
            }, `Request timeout after ${Math.ceil(timeoutMs / 1000)} seconds`));
          }
          throw err;
        } finally {
          if (timeoutId !== null) window.clearTimeout(timeoutId);
        }
      };

      const renderHealth = async () => {
        const root = document.getElementById("aiadmin-health");
        try {
          const data = await request("/api/admin/health", { timeoutMs: 8000 });
          const checks = Object.entries(data.checks || {});
          root.innerHTML = "";
          const overall = document.createElement("p");
          overall.className = data.status === "healthy" ? "ai-admin-status-ok" : "ai-admin-status-error";
          overall.textContent = data.status;
          root.appendChild(overall);
          const grid = document.createElement("div");
          grid.className = "ai-admin-grid";
          checks.forEach(([name, check]) => {
            const item = document.createElement("div");
            item.textContent = `${name}: ${check.status} (${check.latencyMs || 0} ms)`;
            item.className = check.status === "ok" ? "ai-admin-status-ok" : "ai-admin-status-error";
            grid.appendChild(item);
          });
          root.appendChild(grid);
        } catch (err) {
          root.textContent = err.message;
          root.className = "ai-admin-status-error";
        }
      };
      renderHealth();

      const renderSettings = async () => {
        const form = document.getElementById("aiadmin-settings-form");
        const data = await request("/api/admin/llm/config");
        const values = data.values || {};
        llmConfig = values;
        const embeddingData = await request("/api/admin/embedding/config").catch(() => ({ values: {} }));
        const assignmentEmbedding = embeddingData.values || {};
        const fields = [
          ["baseUrl", t("aiadmin-field-litellm-base-url"), "text"],
          ["model", t("aiadmin-field-litellm-model"), "text"],
          ["apiKeyConfigured", t("aiadmin-field-llm-key-configured"), "text", true],
          ["temperature", t("aiadmin-field-temperature"), "number"],
          ["maxTokens", t("aiadmin-field-max-tokens"), "number"],
          ["timeoutMs", t("aiadmin-field-timeout-ms"), "number"],
        ];
        form.innerHTML = "";
        fields.forEach(([name, label, type, readonly]) => {
          const row = document.createElement("div");
          row.className = "ai-admin-row";
          const labelNode = document.createElement("label");
          labelNode.htmlFor = `cfg-${name}`;
          labelNode.textContent = label;
          const input = document.createElement("input");
          input.id = `cfg-${name}`;
          input.name = name;
          input.type = type;
          input.value = values[name] ?? "";
          if (readonly) input.readOnly = true;
          row.append(labelNode, input);
          form.appendChild(row);
        });
        const sourceRow = document.createElement("div");
        sourceRow.className = "ai-admin-row";
        const sourceLabel = document.createElement("label");
        sourceLabel.htmlFor = "cfg-showSources";
        sourceLabel.textContent = t("aiadmin-field-show-sources");
        const sourceInput = document.createElement("input");
        sourceInput.id = "cfg-showSources";
        sourceInput.name = "showSources";
        sourceInput.type = "checkbox";
        sourceInput.checked = Boolean(values.showSources);
        sourceRow.append(sourceLabel, sourceInput);
        form.appendChild(sourceRow);
        const promptRow = document.createElement("div");
        promptRow.className = "ai-admin-row";
        const promptLabel = document.createElement("label");
        promptLabel.htmlFor = "cfg-systemPrompt";
        promptLabel.textContent = t("aiadmin-field-system-prompt");
        const promptInput = document.createElement("textarea");
        promptInput.id = "cfg-systemPrompt";
        promptInput.name = "systemPrompt";
        promptInput.value = values.systemPrompt || "";
        promptRow.append(promptLabel, promptInput);
        form.appendChild(promptRow);

        const assignmentsTitle = document.createElement("h3");
        assignmentsTitle.textContent = t("aiadmin-section-model-assignments");
        form.appendChild(assignmentsTitle);
        const assignmentTable = document.createElement("table");
        assignmentTable.className = "ai-admin-table";
        assignmentTable.innerHTML = tableHtml(["aiadmin-table-action", "aiadmin-field-provider", "aiadmin-table-model"]);
        const assignmentRows = [
          [t("aiadmin-assignment-chat"), "LiteLLM / OpenAI-compatible", values.model || ""],
          [t("aiadmin-assignment-conflicts"), "LiteLLM / OpenAI-compatible", values.model || ""],
          [t("aiadmin-assignment-embeddings"), assignmentEmbedding.provider || "ollama", assignmentEmbedding.model || ""],
          [t("aiadmin-assignment-reindex-enrichment"), "LiteLLM / OpenAI-compatible", values.model || ""],
        ];
        const assignmentBody = assignmentTable.querySelector("tbody");
        assignmentRows.forEach((rowValues) => {
          const row = document.createElement("tr");
          rowValues.forEach((cellValue) => {
            const cell = document.createElement("td");
            cell.textContent = String(cellValue);
            row.appendChild(cell);
          });
          assignmentBody.appendChild(row);
        });
        form.appendChild(assignmentTable);
      };

      const collectSettings = () => {
        const form = document.getElementById("aiadmin-settings-form");
        const data = Object.fromEntries(new FormData(form));
        ["temperature", "maxTokens", "timeoutMs"].forEach((key) => {
          data[key] = Number(data[key]);
        });
        delete data.apiKeyConfigured;
        data.showSources = document.getElementById("cfg-showSources").checked;
        return data;
      };

      const renderLlmTest = (values) => {
        const detail = values.httpStatus ? `HTTP ${values.httpStatus}` : (values.error || "");
        statusText("aiadmin-settings-status", formatText("aiadmin-status-llm-test", { status: values.status, detail }), values.status === "ok");
      };

      const renderServiceConfig = async () => {
        const data = await request("/api/admin/service-config");
        serviceConfig = data.values || {};
        const form = document.getElementById("aiadmin-service-config");
        form.innerHTML = "";
        appendInputRow(form, "svc-database-url", t("aiadmin-field-database-url"), serviceConfig.database?.url, { readonly: true });
        appendInputRow(form, "svc-mediawiki-baseUrl", t("aiadmin-field-mediawiki-base-url"), serviceConfig.mediaWiki?.baseUrl);
        appendInputRow(form, "svc-mediawiki-apiPath", t("aiadmin-field-mediawiki-api-path"), serviceConfig.mediaWiki?.apiPath);
        appendInputRow(form, "svc-gateway-port", t("aiadmin-field-gateway-port"), serviceConfig.gateway?.port, { type: "number", min: 1, max: 65535 });
        appendInputRow(form, "svc-gateway-corsOrigins", t("aiadmin-field-cors-origins"), (serviceConfig.gateway?.corsOrigins || []).join(", "));
        appendInputRow(form, "svc-syncer-baseUrl", t("aiadmin-field-syncer-base-url"), serviceConfig.syncer?.baseUrl);
        appendInputRow(form, "svc-syncer-adminTokenConfigured", t("aiadmin-field-syncer-token-configured"), yesNo(serviceConfig.syncer?.adminTokenConfigured), { readonly: true });
        const syncerMwAuth = serviceConfig.syncer?.mediaWikiServiceAuth || {};
        appendInputRow(form, "svc-syncer-mwAuthConfigured", t("aiadmin-field-syncer-mw-auth-configured"), yesNo(syncerMwAuth.configured), { readonly: true });
        appendInputRow(form, "svc-syncer-mwAuthSource", t("aiadmin-field-syncer-mw-auth-source"), syncerMwAuth.source || unknown(), { readonly: true });
        appendInputRow(form, "svc-syncer-mwAuthSecretRef", t("aiadmin-field-syncer-mw-auth-secret-ref"), yesNo(syncerMwAuth.passwordUsesSecretReference), { readonly: true });
        appendInputRow(form, "svc-syncer-mwAuthPam", t("aiadmin-field-syncer-mw-auth-pam"), yesNo(syncerMwAuth.pamProviderConfigured), { readonly: true });
        appendInputRow(form, "svc-syncer-mwAuthCookie", t("aiadmin-field-syncer-mw-auth-cookie"), yesNo(syncerMwAuth.deprecatedCookieConfigured), { readonly: true });
        appendInputRow(form, "svc-redis-url", t("aiadmin-field-redis-url"), serviceConfig.redis?.url, { readonly: true });
        appendInputRow(form, "svc-qdrant-url", t("aiadmin-field-qdrant-url"), serviceConfig.qdrant?.url);
        appendInputRow(form, "svc-qdrant-collection", t("aiadmin-field-qdrant-collection"), serviceConfig.qdrant?.collection);
        appendInputRow(form, "svc-llm-baseUrl", t("aiadmin-field-litellm-base-url"), serviceConfig.llm?.baseUrl);
        appendInputRow(form, "svc-llm-model", t("aiadmin-field-litellm-model"), serviceConfig.llm?.model);
        appendInputRow(form, "svc-llm-timeoutMs", t("aiadmin-field-llm-timeout-ms"), serviceConfig.llm?.timeoutMs, { type: "number", min: 5000, max: 120000 });
        appendInputRow(form, "svc-llm-apiKeyConfigured", t("aiadmin-field-llm-key-configured"), yesNo(serviceConfig.llm?.apiKeyConfigured), { readonly: true });
        appendSelectRow(form, "svc-embeddings-provider", t("aiadmin-field-provider"), serviceConfig.embeddings?.provider || "ollama", [
          ["ollama", "Ollama"],
          ["openai_compatible", "OpenAI-compatible / LiteLLM"]
        ]);
        appendInputRow(form, "svc-embeddings-baseUrl", t("aiadmin-field-embeddings-base-url"), serviceConfig.embeddings?.baseUrl);
        appendInputRow(form, "svc-embeddings-model", t("aiadmin-field-embeddings-model"), serviceConfig.embeddings?.model);
        appendInputRow(form, "svc-embeddings-dimensions", t("aiadmin-field-embedding-dimensions"), serviceConfig.embeddings?.dimensions, { type: "number", min: 1, max: 4096 });
        appendInputRow(form, "svc-embeddings-apiKeyConfigured", t("aiadmin-field-llm-key-configured"), yesNo(serviceConfig.embeddings?.apiKeyConfigured), { readonly: true });
      };

      const collectServiceConfig = () => ({
        mediaWiki: {
          baseUrl: document.getElementById("svc-mediawiki-baseUrl").value.trim(),
          apiPath: document.getElementById("svc-mediawiki-apiPath").value.trim(),
        },
        gateway: {
          port: Number(document.getElementById("svc-gateway-port").value),
          corsOrigins: document.getElementById("svc-gateway-corsOrigins").value
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        },
        syncer: {
          baseUrl: document.getElementById("svc-syncer-baseUrl").value.trim(),
        },
        qdrant: {
          url: document.getElementById("svc-qdrant-url").value.trim(),
          collection: document.getElementById("svc-qdrant-collection").value.trim(),
        },
        llm: {
          baseUrl: document.getElementById("svc-llm-baseUrl").value.trim(),
          model: document.getElementById("svc-llm-model").value.trim(),
          timeoutMs: Number(document.getElementById("svc-llm-timeoutMs").value),
        },
        embeddings: {
          provider: document.getElementById("svc-embeddings-provider").value,
          baseUrl: document.getElementById("svc-embeddings-baseUrl").value.trim(),
          model: document.getElementById("svc-embeddings-model").value.trim(),
          dimensions: Number(document.getElementById("svc-embeddings-dimensions").value),
        },
      });

      const renderExternalApiConfig = async () => {
        const data = await request("/api/admin/external-api/config");
        externalApiConfig = data.values || {};
        const capabilities = data.capabilities || {};
        const form = document.getElementById("aiadmin-external-api-config");
        form.innerHTML = "";
        appendCheckboxRow(form, "external-enabled", t("aiadmin-field-external-api-enabled"), externalApiConfig.enabled);
        appendCheckboxRow(form, "external-mcp-enabled", t("aiadmin-field-external-mcp-enabled"), externalApiConfig.mcpEnabled);
        appendCheckboxRow(form, "external-anonymous-search", t("aiadmin-field-external-anonymous-search"), externalApiConfig.anonymousSearchAllowed);
        appendInputRow(form, "external-max-top-k", t("aiadmin-field-external-max-top-k"), externalApiConfig.maxTopK || 10, { type: "number", min: 1, max: 50 });
        appendSelectRow(form, "external-acl-mode", t("aiadmin-field-external-acl-mode"), externalApiConfig.aclMode || "mediawiki_check", [
          ["mediawiki_check", t("aiadmin-value-external-acl-mediawiki-check")],
          ["groups_only", t("aiadmin-value-external-acl-groups-only")]
        ]);
        const oidcTitle = document.createElement("h3");
        oidcTitle.textContent = t("aiadmin-section-external-oidc");
        form.appendChild(oidcTitle);
        const oidc = externalApiConfig.oidc || {};
        appendInputRow(form, "external-oidc-issuer", t("aiadmin-field-oidc-issuer"), oidc.issuer || "");
        appendInputRow(form, "external-oidc-audience", t("aiadmin-field-oidc-audience"), oidc.audience || "");
        appendInputRow(form, "external-oidc-jwks-url", t("aiadmin-field-oidc-jwks-url"), oidc.jwksUrl || "");
        appendInputRow(form, "external-oidc-subject-claim", t("aiadmin-field-oidc-subject-claim"), oidc.subjectClaim || "sub");
        appendInputRow(form, "external-oidc-username-claim", t("aiadmin-field-oidc-username-claim"), oidc.usernameClaim || "preferred_username");
        appendInputRow(form, "external-oidc-groups-claim", t("aiadmin-field-oidc-groups-claim"), oidc.groupsClaim || "groups");

        const capabilitiesNode = document.getElementById("aiadmin-external-api-capabilities");
        const authModes = (capabilities.authModes || []).join(", ") || unknown();
        const warnings = (capabilities.warnings || []).join(" ");
        capabilitiesNode.textContent = formatText("aiadmin-status-external-api-capabilities", {
          search: yesNo(capabilities.searchEnabled),
          chat: yesNo(capabilities.chatEnabled),
          mcp: yesNo(capabilities.mcpEnabled),
          auth: authModes,
          topK: capabilities.maxTopK ?? unknown(),
          acl: capabilities.aclMode || unknown(),
          warnings: warnings || ""
        });
      };

      const collectExternalApiConfig = () => ({
        enabled: document.getElementById("external-enabled").checked,
        mcpEnabled: document.getElementById("external-mcp-enabled").checked,
        anonymousSearchAllowed: document.getElementById("external-anonymous-search").checked,
        maxTopK: Number(document.getElementById("external-max-top-k").value),
        aclMode: document.getElementById("external-acl-mode").value,
        oidc: {
          issuer: document.getElementById("external-oidc-issuer").value.trim(),
          audience: document.getElementById("external-oidc-audience").value.trim(),
          jwksUrl: document.getElementById("external-oidc-jwks-url").value.trim(),
          subjectClaim: document.getElementById("external-oidc-subject-claim").value.trim(),
          usernameClaim: document.getElementById("external-oidc-username-claim").value.trim(),
          groupsClaim: document.getElementById("external-oidc-groups-claim").value.trim(),
        },
      });

      const renderServiceTest = (values) => {
        const root = document.getElementById("aiadmin-service-test");
        root.innerHTML = "";
        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml(["aiadmin-table-check", "aiadmin-table-status", "aiadmin-table-details"]);
        const tbody = table.querySelector("tbody");
        const rows = [];
        Object.entries(values.health?.checks || {}).forEach(([name, check]) => {
          rows.push([name, check.status, `${check.latencyMs || 0} ms ${check.error || ""}`]);
        });
        if (values.syncer) rows.push(["syncer", values.syncer.status, `${values.syncer.httpStatus || ""} ${values.syncer.error || ""}`]);
        if (values.mediaWikiServiceAuth) {
          const auth = values.mediaWikiServiceAuth.auth || {};
          const user = values.mediaWikiServiceAuth.user?.username ? `user ${values.mediaWikiServiceAuth.user.username}; ` : "";
          rows.push([
            t("aiadmin-field-syncer-mw-auth-configured"),
            values.mediaWikiServiceAuth.status,
            `${user}source ${auth.source || unknown()}; secret ref ${yesNo(auth.passwordUsesSecretReference)}; PAM ${yesNo(auth.pamProviderConfigured)}; ${values.mediaWikiServiceAuth.error || auth.error || ""}`
          ]);
        }
        if (values.qdrant) {
          rows.push([
            t("aiadmin-table-qdrant-collection"),
            values.qdrant.status,
            `${values.qdrant.collection}; vector ${values.qdrant.vectorSize || unknown()}/${values.qdrant.expectedVectorSize}; points ${values.qdrant.pointsCount ?? unknown()}; ${values.qdrant.error || ""}`
          ]);
        }
        if (values.database) rows.push(["database", values.database.dialect, values.database.url]);
        rows.forEach(([name, status, detail]) => {
          const row = document.createElement("tr");
          [name, status, detail].forEach((cellValue, index) => {
            const cell = document.createElement("td");
            cell.textContent = String(cellValue);
            if (index === 1) cell.className = status === "ok" || status === "sqlite" ? "ai-admin-status-ok" : "";
            row.appendChild(cell);
          });
          tbody.appendChild(row);
        });
        root.appendChild(table);
      };

      const renderEmbeddingConfig = async () => {
        const data = await request("/api/admin/embedding/config");
        embeddingConfig = data.values || {};
        const form = document.getElementById("aiadmin-embedding-config");
        form.innerHTML = "";
        const providerSelect = appendSelectRow(form, "embedding-provider", t("aiadmin-field-provider"), embeddingConfig.provider || "ollama", [
          ["ollama", "Ollama"],
          ["openai_compatible", "OpenAI-compatible / LiteLLM"]
        ]);
        appendInputRow(form, "embedding-baseUrl", t("aiadmin-field-base-url"), embeddingConfig.baseUrl);
        appendInputRow(form, "embedding-model", t("aiadmin-field-model"), embeddingConfig.model);
        appendInputRow(form, "embedding-dimensions", t("aiadmin-field-embedding-dimensions"), embeddingConfig.dimensions || 768, { type: "number", min: 1, max: 4096 });
        appendInputRow(form, "embedding-apiKeyConfigured", t("aiadmin-field-llm-key-configured"), yesNo(embeddingConfig.apiKeyConfigured), { readonly: true });
        providerSelect.addEventListener("change", () => {
          if (providerSelect.value === "openai_compatible") {
            document.getElementById("embedding-baseUrl").value = llmConfig?.baseUrl || "http://localhost:4000/v1";
            document.getElementById("embedding-model").value = "text-embedding-3-small";
            document.getElementById("embedding-dimensions").value = "768";
          } else {
            document.getElementById("embedding-baseUrl").value = "http://localhost:11434";
            document.getElementById("embedding-model").value = "nomic-embed-text";
            document.getElementById("embedding-dimensions").value = "768";
          }
        });
        const root = document.getElementById("aiadmin-embedding-test");
        root.textContent = embeddingConfig.lastTest
          ? formatText("aiadmin-status-last-embedding-test", {
            status: embeddingConfig.lastTest.status,
            dimension: embeddingConfig.lastTest.dimension || unknown(),
            error: embeddingConfig.lastTest.error || ""
          })
          : "";
      };

      const collectEmbeddingConfig = () => ({
        provider: document.getElementById("embedding-provider").value,
        baseUrl: document.getElementById("embedding-baseUrl").value.trim(),
        model: document.getElementById("embedding-model").value.trim(),
        dimensions: Number(document.getElementById("embedding-dimensions").value),
      });

      const renderRagConfig = async () => {
        const [data, indexData] = await Promise.all([
          request("/api/admin/rag/config"),
          request("/api/admin/search-index/status").catch(() => ({ values: null }))
        ]);
        ragConfig = data.values || {};
        const searchIndexStatus = indexData.values || {};
        const form = document.getElementById("aiadmin-rag-config");
        form.innerHTML = "";
        appendInputRow(form, "rag-topK", t("aiadmin-field-top-k"), ragConfig.topK, { type: "number", min: 1, max: 20 });
        appendInputRow(form, "rag-maxContextChunks", t("aiadmin-field-max-context-chunks"), ragConfig.maxContextChunks, { type: "number", min: 1, max: 50 });
        appendInputRow(form, "rag-maxContextChars", t("aiadmin-field-max-context-chars"), ragConfig.maxContextChars, { type: "number", min: 1000, max: 200000 });
        appendInputRow(form, "rag-minSearchScore", t("aiadmin-field-min-search-score"), ragConfig.minSearchScore, { type: "number", min: 0, max: 1, step: "0.01" });
        const hybridTitle = document.createElement("h3");
        hybridTitle.textContent = t("aiadmin-section-hybrid-search");
        form.appendChild(hybridTitle);
        const hybridHelp = document.createElement("p");
        hybridHelp.className = "ai-admin-muted";
        hybridHelp.textContent = t("aiadmin-help-hybrid-search");
        form.appendChild(hybridHelp);
        appendSelectRow(form, "rag-searchMode", t("aiadmin-field-search-mode"), ragConfig.searchMode || "hybrid", [
          ["hybrid", t("aiadmin-value-search-mode-hybrid")],
          ["vector_only", t("aiadmin-value-search-mode-vector-only")],
          ["colbert_full", t("aiadmin-value-search-mode-colbert-full")],
          ["hybrid_colbert", t("aiadmin-value-search-mode-hybrid-colbert")]
        ]);
        appendInputRow(form, "rag-vectorWeight", t("aiadmin-field-vector-weight"), ragConfig.vectorWeight, { type: "number", min: 0, max: 1, step: "0.01" });
        appendInputRow(form, "rag-lexicalWeight", t("aiadmin-field-lexical-weight"), ragConfig.lexicalWeight, { type: "number", min: 0, max: 1, step: "0.01" });
        appendInputRow(form, "rag-vectorCandidateLimit", t("aiadmin-field-vector-candidate-limit"), ragConfig.vectorCandidateLimit, { type: "number", min: 5, max: 200 });
        appendInputRow(form, "rag-lexicalCandidateLimit", t("aiadmin-field-lexical-candidate-limit"), ragConfig.lexicalCandidateLimit, { type: "number", min: 5, max: 200 });
        appendInputRow(form, "rag-lexicalMinMatchedTerms", t("aiadmin-field-lexical-min-matched-terms"), ragConfig.lexicalMinMatchedTerms, { type: "number", min: 1, max: 6 });
        appendSelectRow(form, "rag-lexicalGateMode", t("aiadmin-field-lexical-gate-mode"), ragConfig.lexicalGateMode || "when_bm25_available", [
          ["when_bm25_available", t("aiadmin-value-lexical-gate-when-bm25")],
          ["off", t("aiadmin-value-lexical-gate-off")]
        ]);
        appendCheckboxRow(form, "rag-vectorOnlyFallbackEnabled", t("aiadmin-field-vector-only-fallback-enabled"), ragConfig.vectorOnlyFallbackEnabled);
        appendInputRow(form, "rag-vectorOnlyFallbackMinScore", t("aiadmin-field-vector-only-fallback-min-score"), ragConfig.vectorOnlyFallbackMinScore, { type: "number", min: 0, max: 1, step: "0.01" });
        appendInputRow(form, "rag-minFinalScore", t("aiadmin-field-min-final-score"), ragConfig.minFinalScore, { type: "number", min: 0, max: 1, step: "0.01" });
        appendCheckboxRow(form, "rag-showRawScores", t("aiadmin-field-show-raw-scores"), ragConfig.showRawScores);
        const bm25Status = document.createElement("div");
        bm25Status.className = searchIndexStatus.backfillRecommended ? "ai-admin-status-error" : "ai-admin-status-ok";
        bm25Status.textContent = formatText("aiadmin-status-bm25-index", {
          pages: searchIndexStatus.pages ?? 0,
          chunks: searchIndexStatus.chunks ?? 0,
          ftsChunks: searchIndexStatus.ftsChunks ?? 0,
          latest: searchIndexStatus.latestUpdatedAt || unknown(),
          backfill: yesNo(searchIndexStatus.backfillRecommended)
        });
        form.appendChild(bm25Status);
        const colbertTitle = document.createElement("h3");
        colbertTitle.textContent = t("aiadmin-section-colbert-index");
        form.appendChild(colbertTitle);
        const colbertHelp = document.createElement("p");
        colbertHelp.className = "ai-admin-muted";
        colbertHelp.textContent = t("aiadmin-help-colbert-index");
        form.appendChild(colbertHelp);
        const rerankMode = ragConfig.searchMode === "hybrid_colbert" ? "colbert_v2" : (ragConfig.rerankMode || "none");
        appendSelectRow(form, "rag-rerankMode", t("aiadmin-field-rerank-mode"), rerankMode, [
          ["none", t("aiadmin-value-rerank-none")],
          ["colbert_v2", t("aiadmin-value-rerank-colbert-v2")]
        ]);
        appendInputRow(form, "rag-colbertBaseUrl", t("aiadmin-field-base-url"), ragConfig.colbertBaseUrl || "");
        appendInputRow(form, "rag-colbertModel", t("aiadmin-field-model"), ragConfig.colbertModel || "antoinelouis/colbert-xm");
        appendInputRow(form, "rag-colbertCollection", t("aiadmin-field-colbert-collection"), ragConfig.colbertCollection || "wiki_colbert_chunks");
        appendInputRow(form, "rag-colbertCandidateLimit", t("aiadmin-field-colbert-candidate-limit"), ragConfig.colbertCandidateLimit || 50, { type: "number", min: 5, max: 200 });
        appendInputRow(form, "rag-colbertTimeoutMs", t("aiadmin-field-timeout-ms"), ragConfig.colbertTimeoutMs || 5000, { type: "number", min: 500, max: 60000 });
        appendInputRow(form, "rag-colbertMinScore", t("aiadmin-field-colbert-min-score"), ragConfig.colbertMinScore || 0, { type: "number", min: 0, max: 1, step: "0.01" });
        appendSelectRow(form, "rag-colbertFailMode", t("aiadmin-field-colbert-fail-mode"), ragConfig.colbertFailMode || "fallback_current", [
          ["fallback_current", t("aiadmin-value-fallback-current")],
          ["fail_search", t("aiadmin-value-fail-search")]
        ]);
        const colbertActions = document.createElement("div");
        colbertActions.className = "ai-admin-row";
        colbertActions.innerHTML = `<button type="button" class="ai-admin-btn" id="aiadmin-test-colbert-rag">${t("aiadmin-action-test")}</button><button type="button" class="ai-admin-btn" id="aiadmin-reindex-colbert-rag">${t("aiadmin-action-reindex-colbert")}</button><span id="aiadmin-colbert-test"></span>`;
        form.appendChild(colbertActions);
        appendInputRow(form, "rag-chunkSize", t("aiadmin-field-chunk-size"), ragConfig.chunkSize, { type: "number", min: 128, max: 4096 });
        appendInputRow(form, "rag-chunkOverlap", t("aiadmin-field-chunk-overlap"), ragConfig.chunkOverlap, { type: "number", min: 0, max: 2048 });
        appendInputRow(form, "rag-minChunkLength", t("aiadmin-field-min-chunk-length"), ragConfig.minChunkLength, { type: "number", min: 1, max: 1024 });
        appendInputRow(form, "rag-maxChunksPerPage", t("aiadmin-field-max-chunks-per-page"), ragConfig.maxChunksPerPage, { type: "number", min: 1, max: 10000 });
        appendInputRow(form, "rag-chunkSeparators", t("aiadmin-field-chunk-separators-json"), JSON.stringify(ragConfig.chunkSeparators || []), { textarea: true });
        appendCheckboxRow(form, "rag-semanticFactsInContext", t("aiadmin-field-semantic-facts-in-context"), ragConfig.semanticFactsInContext);
        appendCheckboxRow(form, "rag-includeAttachments", t("aiadmin-field-include-attachments"), ragConfig.includeAttachments);
        appendCheckboxRow(form, "rag-includeSemanticHeader", t("aiadmin-field-include-semantic-header"), ragConfig.includeSemanticHeader);
      };

      const collectRagConfig = () => ({
        topK: Number(document.getElementById("rag-topK").value),
        maxContextChunks: Number(document.getElementById("rag-maxContextChunks").value),
        maxContextChars: Number(document.getElementById("rag-maxContextChars").value),
        minSearchScore: Number(document.getElementById("rag-minSearchScore").value),
        searchMode: document.getElementById("rag-searchMode").value,
        rerankMode: document.getElementById("rag-rerankMode").value,
        vectorWeight: Number(document.getElementById("rag-vectorWeight").value),
        lexicalWeight: Number(document.getElementById("rag-lexicalWeight").value),
        vectorCandidateLimit: Number(document.getElementById("rag-vectorCandidateLimit").value),
        lexicalCandidateLimit: Number(document.getElementById("rag-lexicalCandidateLimit").value),
        lexicalMinMatchedTerms: Number(document.getElementById("rag-lexicalMinMatchedTerms").value),
        lexicalGateMode: document.getElementById("rag-lexicalGateMode").value,
        vectorOnlyFallbackEnabled: document.getElementById("rag-vectorOnlyFallbackEnabled").checked,
        vectorOnlyFallbackMinScore: Number(document.getElementById("rag-vectorOnlyFallbackMinScore").value),
        minFinalScore: Number(document.getElementById("rag-minFinalScore").value),
        showRawScores: document.getElementById("rag-showRawScores").checked,
        colbertEnabled: ["colbert_full", "hybrid_colbert"].includes(document.getElementById("rag-searchMode").value)
          || document.getElementById("rag-rerankMode").value === "colbert_v2",
        colbertBaseUrl: document.getElementById("rag-colbertBaseUrl").value.trim(),
        colbertModel: document.getElementById("rag-colbertModel").value.trim(),
        colbertCollection: document.getElementById("rag-colbertCollection").value.trim(),
        colbertCandidateLimit: Number(document.getElementById("rag-colbertCandidateLimit").value),
        colbertTimeoutMs: Number(document.getElementById("rag-colbertTimeoutMs").value),
        colbertMinScore: Number(document.getElementById("rag-colbertMinScore").value),
        colbertFailMode: document.getElementById("rag-colbertFailMode").value,
        chunkSize: Number(document.getElementById("rag-chunkSize").value),
        chunkOverlap: Number(document.getElementById("rag-chunkOverlap").value),
        minChunkLength: Number(document.getElementById("rag-minChunkLength").value),
        maxChunksPerPage: Number(document.getElementById("rag-maxChunksPerPage").value),
        chunkSeparators: JSON.parse(document.getElementById("rag-chunkSeparators").value),
        semanticFactsInContext: document.getElementById("rag-semanticFactsInContext").checked,
        includeAttachments: document.getElementById("rag-includeAttachments").checked,
        includeSemanticHeader: document.getElementById("rag-includeSemanticHeader").checked,
      });

      const renderWebhookConfig = async () => {
        const data = await request("/api/admin/webhook/config");
        webhookConfig = data.values || {};
        const form = document.getElementById("aiadmin-webhook-config");
        form.innerHTML = "";
        appendInputRow(form, "webhook-syncerUrl", t("aiadmin-field-syncer-url"), webhookConfig.syncerUrl);
        appendInputRow(form, "webhook-mediawiki-syncerUrl", t("aiadmin-field-mediawiki-webhook-url"), mediaWikiSyncerUrl, { readonly: true });
        const expectedUrl = normalizeServiceUrl(webhookConfig.syncerUrl);
        const actualUrl = normalizeServiceUrl(mediaWikiSyncerUrl);
        const warning = document.createElement("div");
        warning.className = expectedUrl === actualUrl ? "ai-admin-status-ok" : "ai-admin-status-error";
        warning.textContent = expectedUrl === actualUrl
          ? t("aiadmin-status-mediawiki-webhook-match")
          : formatText("aiadmin-status-mediawiki-webhook-mismatch", { url: mediaWikiSyncerUrl || "(empty)" });
        form.appendChild(warning);
        appendCheckboxRow(form, "webhook-event-edit", t("aiadmin-field-webhook-event-edit"), webhookConfig.events?.edit);
        appendCheckboxRow(form, "webhook-event-delete", t("aiadmin-field-webhook-event-delete"), webhookConfig.events?.delete);
        appendCheckboxRow(form, "webhook-event-move", t("aiadmin-field-webhook-event-move"), webhookConfig.events?.move);
        appendCheckboxRow(form, "webhook-event-protect", t("aiadmin-field-webhook-event-protect"), webhookConfig.events?.protect);
        appendInputRow(form, "webhook-timeoutMs", t("aiadmin-field-timeout-ms"), webhookConfig.timeoutMs, { type: "number", min: 1000, max: 30000 });
        appendInputRow(form, "webhook-retryCount", t("aiadmin-field-retry-count"), webhookConfig.retryCount, { type: "number", min: 0, max: 10 });
        appendInputRow(form, "webhook-retryBackoffMs", t("aiadmin-field-retry-backoff-ms"), webhookConfig.retryBackoffMs, { type: "number", min: 100, max: 60000 });
        const root = document.getElementById("aiadmin-webhook-test");
        root.textContent = webhookConfig.lastStatus
          ? formatText("aiadmin-status-last-webhook-test", {
            status: webhookConfig.lastStatus.status,
            httpStatus: webhookConfig.lastStatus.httpStatus || "",
            error: webhookConfig.lastStatus.error || ""
          })
          : "";
      };

      const collectWebhookConfig = () => ({
        syncerUrl: document.getElementById("webhook-syncerUrl").value.trim(),
        events: {
          edit: document.getElementById("webhook-event-edit").checked,
          delete: document.getElementById("webhook-event-delete").checked,
          move: document.getElementById("webhook-event-move").checked,
          protect: document.getElementById("webhook-event-protect").checked,
        },
        timeoutMs: Number(document.getElementById("webhook-timeoutMs").value),
        retryCount: Number(document.getElementById("webhook-retryCount").value),
        retryBackoffMs: Number(document.getElementById("webhook-retryBackoffMs").value),
      });

      const renderChatRetentionConfig = async () => {
        const data = await request("/api/admin/chat-retention/config");
        chatRetentionConfig = data.values || {};
        const form = document.getElementById("aiadmin-chat-retention-config");
        form.innerHTML = "";

        appendSelectRow(form, "chat-retention-mode", t("aiadmin-field-retention-mode"), chatRetentionConfig.retentionMode || "archive", [
          ["archive", "archive"],
          ["auto_delete", "auto_delete"],
          ["export_then_archive", "export_then_archive"],
        ]);
        appendInputRow(form, "chat-activeDays", t("aiadmin-field-active-days"), chatRetentionConfig.activeDays, { type: "number", min: 1, max: 3650 });
        appendInputRow(form, "chat-recentDays", t("aiadmin-field-recent-days"), chatRetentionConfig.recentDays, { type: "number", min: 1, max: 3650 });
        appendInputRow(form, "chat-archiveDays", t("aiadmin-field-archive-days"), chatRetentionConfig.archiveDays, { type: "number", min: 1, max: 3650 });
        appendInputRow(form, "chat-maxPinnedChats", t("aiadmin-field-max-pinned-chats"), chatRetentionConfig.maxPinnedChats, { type: "number", min: 0, max: 100 });
        appendInputRow(form, "chat-maxActiveChats", t("aiadmin-field-max-active-chats"), chatRetentionConfig.maxActiveChats, { type: "number", min: 1, max: 10000 });
        appendInputRow(form, "chat-maxTotalChats", t("aiadmin-field-max-total-chats"), chatRetentionConfig.maxTotalChats, { type: "number", min: 1, max: 100000 });
        appendSelectRow(form, "chat-onLimitExceeded", t("aiadmin-field-on-limit-exceeded"), chatRetentionConfig.onLimitExceeded || "delete_oldest", [
          ["delete_oldest", "delete_oldest"],
          ["block_new", "block_new"],
          ["archive_oldest", "archive_oldest"],
        ]);
        appendInputRow(
          form,
          "chat-exportFormats",
          t("aiadmin-field-export-formats-csv"),
          (chatRetentionConfig.exportOptions?.formats || ["json"]).join(", ")
        );
        appendCheckboxRow(form, "chat-includeMetadata", t("aiadmin-field-export-metadata"), chatRetentionConfig.exportOptions?.includeMetadata);
        appendCheckboxRow(form, "chat-includeSources", t("aiadmin-field-export-sources"), chatRetentionConfig.exportOptions?.includeSources);
        appendCheckboxRow(form, "chat-includeMessages", t("aiadmin-field-export-messages"), chatRetentionConfig.exportOptions?.includeMessages);

        const ttl = data.metadata?.redisTtlSeconds;
        const registry = data.metadata?.registry;
        document.getElementById("aiadmin-chat-retention-effective").textContent = ttl
          ? formatText("aiadmin-status-retention-effective", {
            ttl,
            active: registry?.active ?? 0,
            archived: registry?.archived ?? 0,
            exports: registry?.exports ?? 0
          })
          : "";
        await renderChatSessions();
      };

      const collectChatRetentionConfig = () => ({
        retentionMode: document.getElementById("chat-retention-mode").value,
        activeDays: Number(document.getElementById("chat-activeDays").value),
        recentDays: Number(document.getElementById("chat-recentDays").value),
        archiveDays: Number(document.getElementById("chat-archiveDays").value),
        maxPinnedChats: Number(document.getElementById("chat-maxPinnedChats").value),
        maxActiveChats: Number(document.getElementById("chat-maxActiveChats").value),
        maxTotalChats: Number(document.getElementById("chat-maxTotalChats").value),
        onLimitExceeded: document.getElementById("chat-onLimitExceeded").value,
        exportOptions: {
          formats: parseCsv(document.getElementById("chat-exportFormats").value)
            .filter((format) => ["json", "csv", "html"].includes(format)),
          includeMetadata: document.getElementById("chat-includeMetadata").checked,
          includeSources: document.getElementById("chat-includeSources").checked,
          includeMessages: document.getElementById("chat-includeMessages").checked,
        },
      });

      const renderChatSessionMessages = async (session) => {
        const root = document.getElementById("aiadmin-chat-session-detail");
        if (!root) return;
        root.textContent = t("aiadmin-message-running");
        try {
          const data = await request(`/api/admin/chat-sessions/${encodeURIComponent(session.id)}/messages`);
          const messages = data.values || [];
          root.innerHTML = "";

          const heading = document.createElement("h3");
          heading.textContent = `${t("aiadmin-table-conversation")}: ${session.title || session.conversationId}`;
          root.appendChild(heading);

          const meta = document.createElement("div");
          meta.className = "ai-admin-muted";
          meta.textContent = `${t("aiadmin-table-user")}: ${session.username || session.userId}; ${t("aiadmin-table-status")}: ${session.status}; ${t("aiadmin-table-conversation")}: ${session.conversationId}; ${t("aiadmin-table-message-count")}: ${session.messageCount}`;
          root.appendChild(meta);

          if (messages.length === 0) {
            const empty = document.createElement("div");
            empty.className = "ai-admin-muted";
            empty.textContent = t("aiadmin-message-no-chat-messages");
            root.appendChild(empty);
            return;
          }

          const table = document.createElement("table");
          table.className = "ai-admin-table";
          table.innerHTML = tableHtml([
            "aiadmin-table-created",
            "aiadmin-table-role",
            "aiadmin-table-message",
            "aiadmin-table-sources"
          ]);
          const tbody = table.querySelector("tbody");
          messages.forEach((message) => {
            const row = document.createElement("tr");
            [
              message.createdAt || "",
              message.role || "",
              message.content || "",
              JSON.stringify(message.sources || []),
            ].forEach((value) => {
              const cell = document.createElement("td");
              cell.textContent = String(value ?? "");
              row.appendChild(cell);
            });
            tbody.appendChild(row);
          });
          root.appendChild(table);
        } catch (err) {
          root.textContent = err.message;
        }
      };

      const renderChatSessions = async () => {
        const root = document.getElementById("aiadmin-chat-sessions");
        const data = await request("/api/admin/chat-sessions?limit=20");
        const sessions = data.values || [];
        const registry = data.metadata?.registry || {};
        root.innerHTML = "";

        const summary = document.createElement("div");
        summary.className = "ai-admin-muted";
        summary.textContent = formatText("aiadmin-chat-sessions-summary", {
          active: registry.active || 0,
          archived: registry.archived || 0,
          deleted: registry.deleted || 0,
          messages: registry.messages || 0,
        });
        root.appendChild(summary);

        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-conversation",
          "aiadmin-table-user",
          "aiadmin-table-status",
          "aiadmin-table-message-count",
          "aiadmin-table-last-message",
          "aiadmin-table-actions"
        ]);
        const tbody = table.querySelector("tbody");
        sessions.forEach((session) => {
          const row = document.createElement("tr");
          [session.title || session.conversationId, session.username || session.userId, session.status, session.messageCount, session.lastMessageAt || session.createdAt].forEach((value) => {
            const cell = document.createElement("td");
            cell.textContent = String(value ?? "");
            row.appendChild(cell);
          });

          const actions = document.createElement("td");
          const openButton = document.createElement("button");
          openButton.type = "button";
          openButton.className = "ai-admin-btn";
          openButton.textContent = t("aiadmin-action-open");
          openButton.addEventListener("click", () => {
            renderChatSessionMessages(session);
          });

          actions.append(openButton);
          row.appendChild(actions);
          tbody.appendChild(row);
        });
        root.appendChild(table);
        const detail = document.createElement("div");
        detail.id = "aiadmin-chat-session-detail";
        detail.className = "ai-admin-search-results";
        detail.style.marginTop = "12px";
        root.appendChild(detail);
      };

      const parseCsv = (value) => value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      const parseNumberCsv = (value) => parseCsv(value)
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0);

      const autofillModeLabel = (mode) => mode === "apply_empty"
        ? t("aiadmin-value-autofill-mode-apply-empty")
        : t("aiadmin-value-autofill-mode-suggest-only");

      const renderSemanticAutofillStatus = async () => {
        const data = await request("/api/admin/smw/autofill/status?limit=50");
        const values = data.values || {};
        const records = values.records || [];
        const summary = values.summary || {};
        const summaryNode = document.getElementById("aiadmin-autofill-summary");
        if (summaryNode) {
          summaryNode.textContent = formatText("aiadmin-status-autofill-summary", {
            total: values.total ?? records.length,
            auto: summary.auto || 0,
            suggested: summary.suggested || 0,
            user: summary.user || 0,
            disabled: summary.disabled || 0,
          });
        }

        const root = document.getElementById("aiadmin-autofill-fields");
        root.innerHTML = "";
        if (records.length === 0) {
          const empty = document.createElement("div");
          empty.className = "ai-admin-muted";
          empty.textContent = t("aiadmin-empty-no-autofill-fields");
          root.appendChild(empty);
          return;
        }

        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-page",
          "aiadmin-table-property",
          "aiadmin-table-status",
          "aiadmin-table-value",
          "aiadmin-table-confidence",
          "aiadmin-table-updated",
          "aiadmin-table-details"
        ]);
        const tbody = table.querySelector("tbody");
        records.forEach((record) => {
          const row = document.createElement("tr");
          const confidence = Number.isFinite(Number(record.confidence))
            ? Number(record.confidence).toFixed(2)
            : "";
          [
            record.title,
            record.property,
            record.state,
            record.currentValue ?? record.lastAiValue ?? "",
            confidence,
            record.updatedAt || "",
            [record.reason, record.evidence].filter(Boolean).join("; "),
          ].forEach((value) => appendTableCell(row, value));
          tbody.appendChild(row);
        });
        root.appendChild(table);
      };

      const renderSemanticAutofillConfig = async () => {
        const data = await request("/api/admin/smw/autofill/config");
        semanticAutofillConfig = data.values || {};
        const form = document.getElementById("aiadmin-autofill-config");
        form.innerHTML = "";

        appendCheckboxRow(form, "autofill-enabled", t("aiadmin-field-enabled"), semanticAutofillConfig.enabled);
        appendSelectRow(form, "autofill-mode", t("aiadmin-field-autofill-mode"), semanticAutofillConfig.mode || "suggest_only", [
          ["suggest_only", autofillModeLabel("suggest_only")],
          ["apply_empty", autofillModeLabel("apply_empty")],
        ]);
        appendInputRow(form, "autofill-min-confidence", t("aiadmin-field-autofill-min-confidence"), semanticAutofillConfig.minConfidence ?? 0.82, { type: "number", min: 0, max: 1, step: 0.01 });
        appendInputRow(form, "autofill-templates", t("aiadmin-field-templates-csv"), (semanticAutofillConfig.templates || []).join(", "));
        appendInputRow(form, "autofill-namespaces", t("aiadmin-field-namespaces-csv"), (semanticAutofillConfig.namespaces || []).join(", "));
        appendInputRow(form, "autofill-max-page-chars", t("aiadmin-field-max-page-chars"), semanticAutofillConfig.maxPageChars ?? 20000, { type: "number", min: 1000, max: 100000, step: 1000 });
        await renderSemanticAutofillStatus();
      };

      const collectSemanticAutofillConfig = () => ({
        enabled: document.getElementById("autofill-enabled").checked,
        mode: document.getElementById("autofill-mode").value,
        minConfidence: Number(document.getElementById("autofill-min-confidence").value),
        templates: parseCsv(document.getElementById("autofill-templates").value),
        namespaces: parseNumberCsv(document.getElementById("autofill-namespaces").value),
        maxPageChars: Number(document.getElementById("autofill-max-page-chars").value),
      });

      const normalizeTextValue = (value) => String(value || "").trim();
      const uniqueTextValues = (values, normalizer = normalizeTextValue) => Array.from(new Set(
        values.map(normalizer).filter(Boolean)
      ));
      const optionText = (value, fallback = "") => String(value ?? fallback ?? "").trim();
      const setDatalistOptions = (id, values) => {
        const datalist = document.getElementById(id);
        if (!datalist) return;
        datalist.innerHTML = "";
        values.forEach((item) => {
          if (!item.value) return;
          const option = document.createElement("option");
          option.value = item.value;
          if (item.label) {
            option.label = item.label;
            option.title = item.label;
          }
          datalist.appendChild(option);
        });
      };
      const namespaceLabel = (namespace) => {
        const name = namespace.displayName || namespace.name || namespace.canonical || String(namespace.id);
        return `${namespace.id} - ${name}`;
      };
      const propertyEntityOptions = () => trustRulePropertyNames().map((name) => ({
        value: `${name}=`
      }));

      const normalizeCategoryFilterValue = (value) => String(value || "")
        .replace(/^(category|категория):/i, "")
        .replaceAll("_", " ")
        .trim();

      const uniqueCategoryValues = (values) => Array.from(new Set(
        values.map(normalizeCategoryFilterValue).filter(Boolean)
      ));

      const categoryFilterInput = (kind) => document.getElementById(`idx-profile-category-${kind}`);
      const categoryFilterSearch = (kind) => document.getElementById(`idx-profile-category-${kind}-search`);
      const categoryFilterSelect = (kind) => document.getElementById(`idx-profile-category-${kind}-select`);

      const getCategoryFilterValues = (kind) => {
        const input = categoryFilterInput(kind);
        if (!input) return [];
        try {
          const values = JSON.parse(input.dataset.values || "[]");
          if (Array.isArray(values)) return uniqueCategoryValues(values);
        } catch (_err) {
          // Fall back to visible legacy comma-separated value.
        }
        return uniqueCategoryValues(parseCsv(input.value || ""));
      };

      const renderCategoryFilterChips = (kind) => {
        const root = document.getElementById(`idx-profile-category-${kind}-chips`);
        if (!root) return;
        root.innerHTML = "";
        getCategoryFilterValues(kind).forEach((value) => {
          const chip = document.createElement("span");
          chip.className = "ai-admin-chip";
          const text = document.createElement("span");
          text.textContent = value;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "×";
          remove.setAttribute("aria-label", `${t("aiadmin-action-remove")} ${value}`);
          remove.addEventListener("click", () => {
            setCategoryFilterValues(kind, getCategoryFilterValues(kind).filter((item) => item !== value));
          });
          chip.append(text, remove);
          root.appendChild(chip);
        });
      };

      const setCategoryFilterValues = (kind, values) => {
        const input = categoryFilterInput(kind);
        if (!input) return;
        const normalized = uniqueCategoryValues(values);
        input.dataset.values = JSON.stringify(normalized);
        input.value = normalized.join(", ");
        renderCategoryFilterChips(kind);
      };

      const addCategoryFilterValue = (kind) => {
        const search = categoryFilterSearch(kind);
        const select = categoryFilterSelect(kind);
        if (!search) return;
        const value = normalizeCategoryFilterValue(search.value || select?.value);
        if (!value) return;
        setCategoryFilterValues(kind, [...getCategoryFilterValues(kind), value]);
        search.value = "";
        if (select) select.value = "";
      };

      const renderCategoryOptionSelect = (kind) => {
        const select = categoryFilterSelect(kind);
        if (!select) return;
        select.innerHTML = "";
        if (categoryOptions.length === 0) {
          const option = document.createElement("option");
          option.disabled = true;
          option.textContent = t("aiadmin-value-no-categories");
          select.appendChild(option);
          return;
        }
        categoryOptions.forEach((category) => {
          const option = document.createElement("option");
          option.value = category.name;
          option.textContent = category.name;
          option.title = category.title || category.name;
          select.appendChild(option);
        });
      };

      const loadCategoryOptions = async (search = "") => {
        const params = new URLSearchParams({ limit: "50" });
        const trimmed = search.trim();
        if (trimmed) params.set("search", trimmed);
        const data = await request(`/api/admin/wiki/categories?${params.toString()}`);
        const datalist = document.getElementById("idx-profile-category-options");
        if (!datalist) return;
        datalist.innerHTML = "";
        categoryOptions = (data.values || []).filter((category) => category?.name);
        categoryOptions.forEach((category) => {
          if (!category?.name) return;
          const option = document.createElement("option");
          option.value = category.name;
          option.label = category.title || category.name;
          datalist.appendChild(option);
        });
        renderCategoryOptionSelect("include");
        renderCategoryOptionSelect("exclude");
        setDatalistOptions("trust-preview-category-options", categoryOptions.map((category) => ({
          value: category.name,
          label: category.title || category.name
        })));
        renderTrustEntityValueOptions();
        renderTrustRuleValueOptions();
      };

      const renderNamespaceControls = () => {
        const select = document.getElementById("trust-preview-namespace");
        if (!select) return;
        const currentValue = select.value || select.dataset.default || "3030";
        select.innerHTML = "";
        namespaceOptions.forEach((namespace) => {
          const option = document.createElement("option");
          option.value = String(namespace.id);
          option.textContent = namespaceLabel(namespace);
          option.title = namespace.content ? t("aiadmin-value-content-namespace") : t("aiadmin-value-system-namespace");
          select.appendChild(option);
        });
        const hasCurrent = Array.from(select.options).some((option) => option.value === currentValue);
        if (hasCurrent) {
          select.value = currentValue;
        } else if (select.options.length > 0) {
          select.value = select.options[0].value;
        }
        renderTrustEntityValueOptions();
        renderTrustRuleValueOptions();
      };

      const loadNamespaceOptions = async () => {
        const data = await request("/api/admin/wiki/namespaces");
        namespaceOptions = (data.values || []).filter((namespace) => Number.isInteger(namespace?.id));
        renderNamespaceControls();
        return namespaceOptions;
      };

      const loadUserGroupOptions = async () => {
        const data = await request("/api/admin/wiki/user-groups");
        userGroupOptions = (data.values || []).filter((group) => group?.name);
        renderTrustEntityValueOptions();
        renderTrustRuleValueOptions();
        setDatalistOptions("trust-preview-author-group-options", userGroupOptions.map((group) => ({
          value: group.name,
          label: group.displayName || group.name
        })));
        return userGroupOptions;
      };

      const loadTagOptions = async (search = "") => {
        const params = new URLSearchParams({ limit: "50" });
        const trimmed = search.trim();
        if (trimmed) params.set("search", trimmed);
        const data = await request(`/api/admin/wiki/tags?${params.toString()}`);
        tagOptions = (data.values || []).filter((tag) => tag?.name);
        renderTrustEntityValueOptions();
        renderTrustRuleValueOptions();
        setDatalistOptions("trust-preview-tag-options", tagOptions.map((tag) => ({
          value: tag.name,
          label: tag.displayName || tag.name
        })));
        return tagOptions;
      };

      const loadTemplateOptions = async (search = "") => {
        const params = new URLSearchParams({ limit: "50" });
        const trimmed = search.trim();
        if (trimmed) params.set("search", trimmed);
        const data = await request(`/api/admin/wiki/templates?${params.toString()}`);
        templateOptions = (data.values || []).filter((template) => template?.name);
        renderTrustEntityValueOptions();
        renderTrustRuleValueOptions();
        setDatalistOptions("trust-preview-template-options", templateOptions.map((template) => ({
          value: template.name,
          label: template.title || template.name
        })));
        return templateOptions;
      };

      const loadPageOptions = async (search = "") => {
        const params = new URLSearchParams({ limit: "50" });
        const trimmed = search.trim();
        if (trimmed) params.set("search", trimmed);
        const data = await request(`/api/admin/wiki/pages?${params.toString()}`);
        pageOptions = (data.values || []).filter((page) => page?.title);
        setDatalistOptions("trust-preview-title-options", pageOptions.map((page) => ({
          value: page.title,
          label: `${page.namespace ?? 0}${page.pageId ? ` #${page.pageId}` : ""}`
        })));
        renderTrustRuleValueOptions();
        return pageOptions;
      };

      const scheduleWikiReferenceLoad = (key, value, loader, statusId = "aiadmin-trust-rule-status") => {
        if (wikiReferenceTimers[key]) window.clearTimeout(wikiReferenceTimers[key]);
        wikiReferenceTimers[key] = window.setTimeout(() => {
          loader(value).catch((err) => statusText(statusId, err.message, false));
        }, 250);
      };

      const setTrustRuleInputVisible = (id, visible) => {
        const input = document.getElementById(id);
        const label = document.querySelector(`label[for="${id}"]`);
        [input, label].forEach((node) => {
          if (!node) return;
          node.classList.toggle("ai-admin-hidden", !visible);
        });
      };

      const trustRulePropertyNames = () => Array.from(new Set([
        "Статус документа",
        ...ontologyProperties.map((property) => property.name).filter(Boolean),
        ...Object.keys(semanticPropertyValues),
      ])).sort((left, right) => left.localeCompare(right));

      const selectedTrustRulePropertyName = () => {
        const field = document.getElementById("trust-rule-field")?.value;
        const rawValue = document.getElementById("trust-rule-property")?.value.trim() || "";
        if (field === "status") return rawValue || "Статус документа";
        return rawValue;
      };

      const propertyValueOptions = (propertyName) => (
        semanticPropertyValues[propertyName] || []
      ).map((value) => ({ value }));

      const renderTrustRulePropertyOptions = () => {
        const datalist = document.getElementById("trust-rule-property-options");
        if (!datalist) return;
        datalist.innerHTML = "";
        trustRulePropertyNames().forEach((name) => {
          const option = document.createElement("option");
          option.value = name;
          const property = ontologyProperties.find((item) => item.name === name);
          option.label = property?.label || name;
          datalist.appendChild(option);
        });
      };

      const trustEntityValueOptions = (entityType) => {
        if (entityType === "namespace") {
          return namespaceOptions.map((namespace) => ({
            value: String(namespace.id),
            label: namespaceLabel(namespace)
          }));
        }
        if (entityType === "category") {
          return categoryOptions.map((category) => ({
            value: category.name,
            label: category.title || category.name
          }));
        }
        if (entityType === "tag") {
          return tagOptions.map((tag) => ({
            value: tag.name,
            label: tag.displayName || tag.name
          }));
        }
        if (entityType === "author_group") {
          return userGroupOptions.map((group) => ({
            value: group.name,
            label: group.displayName || group.name
          }));
        }
        if (entityType === "template") {
          return templateOptions.map((template) => ({
            value: template.name,
            label: template.title || template.name
          }));
        }
        if (["page_property", "smw_property", "date_property"].includes(entityType)) {
          return propertyEntityOptions();
        }
        return [];
      };

      const trustEntityValuePlaceholder = (entityType) => {
        if (entityType === "namespace") return "3030";
        if (entityType === "category") return "ИТ";
        if (entityType === "tag") return "verified";
        if (entityType === "author_group") return "sysop";
        if (entityType === "template") return "ApprovedDocument";
        return "Статус документа=Утвержден";
      };

      const renderTrustEntityValueOptions = () => {
        const input = document.getElementById("trust-entity-value");
        const entityType = document.getElementById("trust-entity-type")?.value || "namespace";
        if (input) input.placeholder = trustEntityValuePlaceholder(entityType);
        setDatalistOptions("trust-entity-value-options", trustEntityValueOptions(entityType));
      };

      const trustRuleFieldValueLabel = (field, operator) => {
        if (operator === "older_than_days" || operator === "newer_than_days") return t("aiadmin-field-days");
        if (field === "category") return t("aiadmin-field-category");
        if (field === "namespace") return t("aiadmin-field-namespace");
        if (field === "template") return t("aiadmin-field-template");
        if (field === "tag") return t("aiadmin-field-tag");
        if (field === "author_group") return t("aiadmin-field-author-group");
        if (field === "property" || field === "status" || field === "date_property") return t("aiadmin-field-property-value");
        return t("aiadmin-field-value");
      };

      const trustRuleValueOptions = (field, operator) => {
        if (field === "namespace") {
          return namespaceOptions.map((namespace) => ({
            value: String(namespace.id),
            label: namespaceLabel(namespace)
          }));
        }
        if (field === "title") {
          return pageOptions.map((page) => ({
            value: page.title,
            label: `${page.namespace ?? 0}${page.pageId ? ` #${page.pageId}` : ""}`
          }));
        }
        if (field === "category") {
          return categoryOptions.map((category) => ({
            value: category.name,
            label: category.title || category.name
          }));
        }
        if (field === "tag") {
          return tagOptions.map((tag) => ({
            value: tag.name,
            label: tag.displayName || tag.name
          }));
        }
        if (field === "author_group") {
          return userGroupOptions.map((group) => ({
            value: group.name,
            label: group.displayName || group.name
          }));
        }
        if (field === "template") {
          return templateOptions.map((template) => ({
            value: template.name,
            label: template.title || template.name
          }));
        }
        if (
          ["property", "status", "date_property"].includes(field) &&
          operator !== "older_than_days" &&
          operator !== "newer_than_days"
        ) {
          return propertyValueOptions(selectedTrustRulePropertyName());
        }
        return [];
      };

      const trustRuleValuePlaceholder = (field) => {
        if (field === "namespace") return "3030";
        if (field === "title") return "CorpIT:Инструкция VPN";
        if (field === "category") return t("aiadmin-placeholder-select-category");
        if (field === "tag") return "verified";
        if (field === "author_group") return "sysop";
        if (field === "template") return "ApprovedDocument";
        if (field === "date_property") return "365";
        return t("aiadmin-placeholder-condition-value");
      };

      const renderTrustRuleValueOptions = () => {
        const datalist = document.getElementById("trust-rule-value-options");
        const input = document.getElementById("trust-rule-value");
        const select = document.getElementById("trust-rule-value-select");
        const label = document.querySelector("label[for=\"trust-rule-value\"], label[for=\"trust-rule-value-select\"]");
        const field = document.getElementById("trust-rule-field")?.value;
        const operator = document.getElementById("trust-rule-operator")?.value;
        const valueVisible = operator !== "exists";
        const useNamespaceSelect = valueVisible && field === "namespace" && namespaceOptions.length > 0;

        if (label) {
          label.classList.toggle("ai-admin-hidden", !valueVisible);
          label.htmlFor = useNamespaceSelect ? "trust-rule-value-select" : "trust-rule-value";
        }
        if (input) {
          input.classList.toggle("ai-admin-hidden", !valueVisible || useNamespaceSelect);
        }
        if (select) {
          select.classList.toggle("ai-admin-hidden", !useNamespaceSelect);
          select.innerHTML = "";
          if (useNamespaceSelect) {
            const currentValue = input?.value || select.value || "";
            namespaceOptions.forEach((namespace) => {
              const option = document.createElement("option");
              option.value = String(namespace.id);
              option.textContent = namespaceLabel(namespace);
              option.title = namespace.content ? t("aiadmin-value-content-namespace") : t("aiadmin-value-system-namespace");
              select.appendChild(option);
            });
            if (Array.from(select.options).some((option) => option.value === currentValue)) {
              select.value = currentValue;
            } else if (select.options.length > 0) {
              select.value = select.options[0].value;
            }
            if (input) input.value = select.value;
          }
        }
        if (!datalist) return;
        setDatalistOptions("trust-rule-value-options", useNamespaceSelect ? [] : trustRuleValueOptions(field, operator));
      };

      const updateTrustRuleConditionControls = () => {
        const field = document.getElementById("trust-rule-field").value;
        const operator = document.getElementById("trust-rule-operator").value;
        const propertyInput = document.getElementById("trust-rule-property");
        const valueInput = document.getElementById("trust-rule-value");
        const propertyVisible = ["property", "status", "date_property"].includes(field);

        if (field === "status" && !propertyInput.value.trim()) {
          propertyInput.value = "Статус документа";
        }
        if (!propertyVisible && propertyInput.value.trim() && field !== "status") {
          propertyInput.value = "";
        }

        setTrustRuleInputVisible("trust-rule-property", propertyVisible);
        const valueLabel = document.querySelector("label[for=\"trust-rule-value\"], label[for=\"trust-rule-value-select\"]");
        if (valueLabel) valueLabel.textContent = trustRuleFieldValueLabel(field, operator);
        valueInput.placeholder = trustRuleValuePlaceholder(field);
        renderTrustRulePropertyOptions();
        renderTrustRuleValueOptions();
      };

      const trustRuleFlags = () => parseCsv(document.getElementById("trust-rule-flags").value);

      const knownTrustRuleFlags = () => Array.from(new Set([
        ...defaultTrustRuleFlags,
        ...trustRules.flatMap((rule) => rule.flags || []),
        ...trustRuleFlags(),
      ].map((flag) => String(flag || "").trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));

      const renderTrustRuleFlagOptions = () => {
        const datalist = document.getElementById("trust-rule-flag-options");
        if (!datalist) return;
        datalist.innerHTML = "";
        knownTrustRuleFlags().forEach((flag) => {
          const option = document.createElement("option");
          option.value = flag;
          datalist.appendChild(option);
        });
      };

      const setTrustRuleFlags = (flags) => {
        const normalized = Array.from(new Set(
          flags.map((flag) => String(flag || "").trim()).filter(Boolean)
        ));
        document.getElementById("trust-rule-flags").value = normalized.join(", ");
        renderTrustRuleFlagChips();
        renderTrustRuleFlagOptions();
      };

      const renderTrustRuleFlagChips = () => {
        const root = document.getElementById("trust-rule-flags-list");
        if (!root) return;
        root.innerHTML = "";
        const flags = trustRuleFlags();
        if (flags.length === 0) {
          root.textContent = t("aiadmin-value-none");
          return;
        }
        flags.forEach((flag) => {
          const chip = document.createElement("span");
          chip.className = "ai-admin-chip";
          const text = document.createElement("span");
          text.textContent = flag;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "×";
          remove.addEventListener("click", () => {
            setTrustRuleFlags(trustRuleFlags().filter((item) => item !== flag));
          });
          chip.append(text, remove);
          root.appendChild(chip);
        });
      };

      const addTrustRuleFlag = () => {
        const input = document.getElementById("trust-rule-new-flag");
        const flag = input.value.trim();
        if (!flag) return;
        setTrustRuleFlags([...trustRuleFlags(), flag]);
        input.value = "";
      };

      const scheduleCategoryOptionsLoad = (value, statusId = "aiadmin-indexing-profile-status") => {
        if (categoryOptionsTimer) window.clearTimeout(categoryOptionsTimer);
        categoryOptionsTimer = window.setTimeout(() => {
          loadCategoryOptions(value).catch((err) => statusText(statusId, err.message, false));
        }, 250);
      };

      const activeTrustModel = () => (
        trustModels.find((model) => model.id === activeTrustModelId) ||
        trustModels.find((model) => model.active) ||
        trustModels[0] ||
        null
      );
      const selectedTrustModelId = () => activeTrustModel()?.id || "default";

      const resetTrustEntityForm = () => {
        document.getElementById("trust-entity-id").value = "";
        document.getElementById("trust-entity-type").value = "namespace";
        document.getElementById("trust-entity-name").value = "";
        document.getElementById("trust-entity-value").value = "";
        document.getElementById("trust-entity-weight").value = 0;
        document.getElementById("trust-entity-enabled").checked = true;
        renderTrustEntityValueOptions();
      };

      const populateTrustEntityForm = (entity) => {
        document.getElementById("trust-entity-id").value = entity.id;
        document.getElementById("trust-entity-type").value = entity.entityType;
        document.getElementById("trust-entity-name").value = entity.name;
        document.getElementById("trust-entity-value").value = entity.value;
        document.getElementById("trust-entity-weight").value = entity.weight;
        document.getElementById("trust-entity-enabled").checked = Boolean(entity.enabled);
        renderTrustEntityValueOptions();
      };

      const resetTrustRuleForm = () => {
        document.getElementById("trust-rule-id").value = "";
        document.getElementById("trust-rule-name").value = "";
        document.getElementById("trust-rule-modifier").value = 0;
        document.getElementById("trust-rule-field").value = "namespace";
        document.getElementById("trust-rule-operator").value = "equals";
        document.getElementById("trust-rule-property").value = "";
        document.getElementById("trust-rule-value").value = "";
        setTrustRuleFlags([]);
        document.getElementById("trust-rule-order").value = 100;
        document.getElementById("trust-rule-enabled").checked = true;
        document.getElementById("trust-rule-exclude").checked = false;
        document.getElementById("trust-rule-manual").checked = false;
        document.getElementById("trust-rule-notify").checked = false;
        updateTrustRuleConditionControls();
      };

      const populateTrustRuleForm = (rule) => {
        const condition = rule.condition || {};
        document.getElementById("trust-rule-id").value = rule.id;
        document.getElementById("trust-rule-name").value = rule.name;
        document.getElementById("trust-rule-modifier").value = rule.modifier;
        document.getElementById("trust-rule-field").value = condition.field || "namespace";
        document.getElementById("trust-rule-operator").value = condition.operator || "equals";
        document.getElementById("trust-rule-property").value = condition.propertyName || "";
        document.getElementById("trust-rule-value").value = condition.value || "";
        setTrustRuleFlags(rule.flags || []);
        document.getElementById("trust-rule-order").value = rule.displayOrder ?? 100;
        document.getElementById("trust-rule-enabled").checked = Boolean(rule.enabled);
        document.getElementById("trust-rule-exclude").checked = Boolean(rule.excludeFromIndex);
        document.getElementById("trust-rule-manual").checked = Boolean(rule.requireManualApproval);
        document.getElementById("trust-rule-notify").checked = Boolean(rule.notifyAuthor);
        updateTrustRuleConditionControls();
      };

      const trustRuleValue = (rule, key) => {
        if (key === "condition") {
          const condition = rule.condition || {};
          return `${condition.field || ""} ${condition.operator || ""} ${condition.propertyName || ""} ${condition.value || ""}`;
        }
        if (key === "flags") return (rule.flags || []).join(", ");
        return rule[key];
      };

      const appendFlagChipsCell = (row, flags) => {
        const cell = document.createElement("td");
        const values = Array.isArray(flags) ? flags : [];
        if (values.length === 0) {
          cell.textContent = t("aiadmin-value-none");
        } else {
          const list = document.createElement("div");
          list.className = "ai-admin-chip-list";
          values.forEach((flag) => {
            const chip = document.createElement("span");
            chip.className = "ai-admin-chip";
            chip.textContent = flag;
            list.appendChild(chip);
          });
          cell.appendChild(list);
        }
        row.appendChild(cell);
        return cell;
      };

      const propertyConditionFromEntityValue = (field, rawValue) => {
        const value = String(rawValue || "").trim();
        const separator = value.indexOf("=");
        const propertyName = separator >= 0 ? value.slice(0, separator).trim() : value;
        const propertyValue = separator >= 0 ? value.slice(separator + 1).trim() : "";
        const condition = {
          field,
          operator: propertyValue ? "equals" : "exists",
        };
        if (propertyName) condition.propertyName = propertyName;
        if (propertyValue) condition.value = propertyValue;
        return condition;
      };

      const trustEntityCondition = (entity) => {
        const value = String(entity.value || "").trim();
        if (entity.entityType === "page_property" || entity.entityType === "smw_property") {
          return propertyConditionFromEntityValue("property", value);
        }
        if (entity.entityType === "date_property") {
          return propertyConditionFromEntityValue("date_property", value);
        }
        const fieldMap = {
          namespace: "namespace",
          category: "category",
          tag: "tag",
          author_group: "author_group",
          template: "template",
        };
        return {
          field: fieldMap[entity.entityType] || "property",
          operator: "equals",
          value,
        };
      };

      const convertedEntityRuleId = (entity) => `entity-${entity.id}`;

      const trustPolicyRowFromEntity = (entity) => ({
        source: "entity",
        sourceLabel: t("aiadmin-trust-source-legacy-entity"),
        rowId: `entity:${entity.id}`,
        rawId: entity.id,
        id: convertedEntityRuleId(entity),
        legacyId: entity.id,
        name: entity.name,
        enabled: Boolean(entity.enabled),
        condition: trustEntityCondition(entity),
        modifier: Number(entity.weight || 0),
        flags: [],
        excludeFromIndex: false,
        requireManualApproval: false,
        notifyAuthor: false,
        displayOrder: 100,
        updatedAt: entity.updatedAt || "",
      });

      const trustPolicyRowFromRule = (rule) => ({
        source: "rule",
        sourceLabel: rule.entityId
          ? `${t("aiadmin-trust-source-legacy-rule")} ${rule.entityId}`
          : t("aiadmin-trust-source-rule"),
        rowId: `rule:${rule.id}`,
        rawId: rule.id,
        id: rule.id,
        entityId: rule.entityId,
        name: rule.name,
        enabled: Boolean(rule.enabled),
        condition: rule.condition || { field: "namespace", operator: "equals" },
        modifier: Number(rule.modifier || 0),
        flags: rule.flags || [],
        excludeFromIndex: Boolean(rule.excludeFromIndex),
        requireManualApproval: Boolean(rule.requireManualApproval),
        notifyAuthor: Boolean(rule.notifyAuthor),
        displayOrder: rule.displayOrder ?? 100,
        updatedAt: rule.updatedAt || "",
      });

      const trustPolicyValue = (row, key) => {
        if (key === "condition") return trustRuleValue(row, "condition");
        if (key === "flags") return (row.flags || []).join(", ");
        if (key === "source") return row.sourceLabel;
        return row[key];
      };

      const selectedTrustPolicyRow = () => trustPolicyRows.find((row) => row.rowId === selectedTrustPolicyRowId) || null;

      const updateSelectedTrustPolicyPointers = (row) => {
        selectedTrustPolicyRowId = row?.rowId || null;
        selectedTrustEntityId = row?.source === "entity" ? row.rawId : row?.entityId || null;
        selectedTrustRuleId = row?.source === "rule" ? row.rawId : null;
      };

      const selectTrustPolicyRow = (rowId) => {
        const row = trustPolicyRows.find((item) => item.rowId === rowId) || null;
        updateSelectedTrustPolicyPointers(row);
        if (row) populateTrustRuleForm(row);
        else resetTrustRuleForm();
        renderTrustPolicyRows();
      };

      const selectTrustEntity = async (_modelId, entityId) => {
        selectTrustPolicyRow(`entity:${entityId}`);
      };

      const selectTrustRule = (ruleId) => {
        selectTrustPolicyRow(`rule:${ruleId}`);
      };

      const trustRuleInputFromStoredRule = (rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: Boolean(rule.enabled),
        condition: rule.condition || { field: "namespace", operator: "equals" },
        modifier: Number(rule.modifier || 0),
        flags: rule.flags || [],
        excludeFromIndex: Boolean(rule.excludeFromIndex),
        requireManualApproval: Boolean(rule.requireManualApproval),
        notifyAuthor: Boolean(rule.notifyAuthor),
        displayOrder: rule.displayOrder ?? 100,
      });

      const detachLegacyEntityRules = async (modelId, entityId) => {
        const legacyRules = trustRules.filter((rule) => rule.entityId === entityId);
        for (const rule of legacyRules) {
          await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/rules`, {
            method: "POST",
            body: JSON.stringify(trustRuleInputFromStoredRule(rule)),
          });
        }
        return legacyRules.length;
      };

      const renderTrustPolicyRows = () => {
        const tbody = document.querySelector("#aiadmin-trust-entities table tbody");
        if (!tbody) return;
        tbody.innerHTML = "";
        const sorted = sortedRows(trustPolicyRows, trustPolicySort, trustPolicyValue);
        if (sorted.length === 0) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 10;
          cell.textContent = t("aiadmin-empty-no-trust-rules");
          row.appendChild(cell);
          tbody.appendChild(row);
          return;
        }
        sorted.forEach((rule) => {
          const row = document.createElement("tr");
          row.className = "ai-admin-clickable-row";
          row.classList.toggle("ai-admin-row-selected", rule.rowId === selectedTrustPolicyRowId);
          row.addEventListener("click", () => selectTrustPolicyRow(rule.rowId));
          appendTableCell(row, rule.id);
          appendTableCell(row, rule.name);
          appendTableCell(row, rule.sourceLabel);
          appendTableCell(row, trustRuleValue(rule, "condition"));
          appendTableCell(row, rule.modifier);
          appendFlagChipsCell(row, rule.flags || []);
          appendTableCell(row, rule.displayOrder);
          appendTableCell(row, yesNo(rule.enabled));
          appendTableCell(row, rule.updatedAt || "");
          const actions = document.createElement("td");
          actions.className = "ai-admin-action-cell";
          const deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.className = "ai-admin-btn ai-admin-btn-danger";
          deleteButton.textContent = t("aiadmin-action-delete");
          deleteButton.addEventListener("click", async (event) => {
            event.stopPropagation();
            updateSelectedTrustPolicyPointers(rule);
            await deleteSelectedTrustRule();
          });
          actions.appendChild(deleteButton);
          row.appendChild(actions);
          tbody.appendChild(row);
        });
      };

      const renderTrustRules = async (modelId, _entityId, preferredRuleId = selectedTrustRuleId) => {
        await renderTrustEntities(modelId, preferredRuleId ? `rule:${preferredRuleId}` : selectedTrustPolicyRowId);
      };

      const renderTrustEntities = async (modelId, preferredRowId = selectedTrustPolicyRowId) => {
        const [entitiesData, rulesData] = await Promise.all([
          request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/entities`),
          request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/rules`),
        ]);
        trustEntities = entitiesData.values || [];
        trustRules = rulesData.values || [];
        trustPolicyRows = [
          ...trustEntities.map(trustPolicyRowFromEntity),
          ...trustRules.map(trustPolicyRowFromRule),
        ];
        renderTrustRuleFlagOptions();
        const root = document.getElementById("aiadmin-trust-entities");
        root.className = "ai-admin-search-results";
        root.innerHTML = "";
        const trustTable = document.createElement("table");
        trustTable.className = "ai-admin-table";
        const columns = [
          { key: "id", label: "aiadmin-table-id" },
          { key: "name", label: "aiadmin-table-name" },
          { key: "source", label: "aiadmin-table-source" },
          { key: "condition", label: "aiadmin-table-condition" },
          { key: "modifier", label: "aiadmin-table-modifier" },
          { key: "flags", label: "aiadmin-table-flags" },
          { key: "displayOrder", label: "aiadmin-table-display-order" },
          { key: "enabled", label: "aiadmin-table-enabled" },
          { key: "updatedAt", label: "aiadmin-table-updated" },
        ];
        const thead = document.createElement("thead");
        const header = document.createElement("tr");
        columns.forEach((column) => appendSortableHeader(header, column, trustPolicySort, (key) => {
          trustPolicySort = {
            key,
            direction: trustPolicySort.key === key && trustPolicySort.direction === "asc" ? "desc" : "asc",
          };
          renderTrustEntities(modelId, selectedTrustPolicyRowId).catch((err) => {
            root.textContent = err.message;
          });
        }));
        const actionHeader = document.createElement("th");
        actionHeader.textContent = t("aiadmin-table-actions");
        header.appendChild(actionHeader);
        thead.appendChild(header);
        trustTable.appendChild(thead);
        trustTable.appendChild(document.createElement("tbody"));
        root.appendChild(trustTable);

        const preferredIds = [
          preferredRowId,
          preferredRowId ? `entity:${preferredRowId}` : null,
          preferredRowId ? `rule:${preferredRowId}` : null,
          selectedTrustPolicyRowId,
          selectedTrustRuleId ? `rule:${selectedTrustRuleId}` : null,
          selectedTrustEntityId ? `entity:${selectedTrustEntityId}` : null,
        ].filter(Boolean);
        const selected = trustPolicyRows.find((row) => preferredIds.includes(row.rowId)) || trustPolicyRows[0] || null;
        updateSelectedTrustPolicyPointers(selected);

        if (selected?.source === "entity") {
          const entity = trustEntities.find((item) => item.id === selected.rawId);
          if (entity) populateTrustEntityForm(entity);
        } else {
          resetTrustEntityForm();
        }
        if (selected) {
          populateTrustRuleForm(selected);
        } else {
          resetTrustEntityForm();
          resetTrustRuleForm();
        }
        renderTrustPolicyRows();
      };

      const renderTrustModels = async () => {
        const data = await request("/api/admin/trust-models");
        trustModels = data.values || [];
        const root = document.getElementById("aiadmin-trust-models");
        root.innerHTML = "";

        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-id",
          "aiadmin-table-name",
          "aiadmin-table-active",
          "aiadmin-table-base",
          "aiadmin-table-min-context",
          "aiadmin-table-policies"
        ]);
        const tbody = table.querySelector("tbody");
        trustModels.forEach((model) => {
          const row = document.createElement("tr");
          [
            model.id,
            model.name,
            yesNo(model.active),
            model.baseScore,
            model.minTrustScoreForContext,
            `drafts=${yesNo(model.includeDrafts)}; staleness=-${model.stalenessPenaltyPerYear ?? 0.1}/year; sources=${yesNo(model.requireSources)}`,
          ].forEach((cellValue) => {
            const cell = document.createElement("td");
            cell.textContent = String(cellValue);
            row.appendChild(cell);
          });
          tbody.appendChild(row);
        });
        root.appendChild(table);

        const selected = trustModels.find((model) => model.active) || trustModels[0];
        if (selected) {
          activeTrustModelId = selected.id;
          document.getElementById("trust-model-id").value = selected.id;
          document.getElementById("trust-model-name").value = selected.name;
          document.getElementById("trust-base-score").value = selected.baseScore;
          document.getElementById("trust-min-context").value = selected.minTrustScoreForContext;
          document.getElementById("trust-model-active").checked = Boolean(selected.active);
          document.getElementById("trust-include-drafts").checked = Boolean(selected.includeDrafts);
          document.getElementById("trust-staleness-penalty").value = selected.stalenessPenaltyPerYear ?? 0.1;
          document.getElementById("trust-require-verified").checked = Boolean(selected.requireVerifiedForDirectAnswer);
          document.getElementById("trust-require-sources").checked = Boolean(selected.requireSources);
          await renderTrustEntities(selected.id);
        } else {
          activeTrustModelId = null;
          root.textContent = t("aiadmin-value-none");
        }
      };

      const collectTrustModel = () => {
        const id = document.getElementById("trust-model-id").value.trim();
        const model = {
          name: document.getElementById("trust-model-name").value.trim(),
          active: document.getElementById("trust-model-active").checked,
          baseScore: Number(document.getElementById("trust-base-score").value),
          minTrustScoreForContext: Number(document.getElementById("trust-min-context").value),
          includeDrafts: document.getElementById("trust-include-drafts").checked,
          stalenessPenaltyPerYear: Number(document.getElementById("trust-staleness-penalty").value || "0.1"),
          requireVerifiedForDirectAnswer: document.getElementById("trust-require-verified").checked,
          requireSources: document.getElementById("trust-require-sources").checked,
        };
        if (id) model.id = id;
        return model;
      };

      const collectTrustEntity = () => {
        const id = document.getElementById("trust-entity-id").value.trim();
        const entity = {
          entityType: document.getElementById("trust-entity-type").value,
          name: document.getElementById("trust-entity-name").value.trim(),
          value: document.getElementById("trust-entity-value").value.trim(),
          weight: Number(document.getElementById("trust-entity-weight").value),
          enabled: document.getElementById("trust-entity-enabled").checked,
        };
        if (id) entity.id = id;
        return entity;
      };

      const collectTrustRule = () => {
        const id = document.getElementById("trust-rule-id").value.trim();
        const field = document.getElementById("trust-rule-field").value;
        const operator = document.getElementById("trust-rule-operator").value;
        const propertyName = ["property", "status", "date_property"].includes(field)
          ? document.getElementById("trust-rule-property").value.trim()
          : "";
        const rawValue = field === "namespace"
          ? document.getElementById("trust-rule-value-select").value || document.getElementById("trust-rule-value").value
          : document.getElementById("trust-rule-value").value;
        const value = operator === "exists" ? "" : rawValue.trim();
        const rule = {
          name: document.getElementById("trust-rule-name").value.trim(),
          enabled: document.getElementById("trust-rule-enabled").checked,
          condition: {
            field,
            operator,
          },
          modifier: Number(document.getElementById("trust-rule-modifier").value),
          flags: parseCsv(document.getElementById("trust-rule-flags").value),
          excludeFromIndex: document.getElementById("trust-rule-exclude").checked,
          requireManualApproval: document.getElementById("trust-rule-manual").checked,
          notifyAuthor: document.getElementById("trust-rule-notify").checked,
          displayOrder: Number(document.getElementById("trust-rule-order").value || "100"),
        };
        if (id) rule.id = id;
        if (propertyName) rule.condition.propertyName = propertyName;
        if (value) rule.condition.value = value;
        return rule;
      };

      const saveTrustPolicyRule = async () => {
        const modelId = selectedTrustModelId();
        const row = selectedTrustPolicyRow();
        const payload = collectTrustRule();
        if (row?.source === "entity") {
          await detachLegacyEntityRules(modelId, row.rawId);
        }
        const data = await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/rules`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (row?.source === "entity") {
          await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/entities/${encodeURIComponent(row.rawId)}`, {
            method: "DELETE",
          });
        }
        selectedTrustRuleId = data.values?.id || payload.id || selectedTrustRuleId;
        selectedTrustEntityId = null;
        selectedTrustPolicyRowId = selectedTrustRuleId ? `rule:${selectedTrustRuleId}` : null;
        await renderTrustEntities(modelId, selectedTrustPolicyRowId);
        return data.values;
      };

      const deleteSelectedTrustEntity = async () => {
        const modelId = selectedTrustModelId();
        const entity = trustEntities.find((item) => item.id === selectedTrustEntityId);
        if (!modelId || !entity) {
          statusText("aiadmin-trust-entity-status", t("aiadmin-empty-select-trust-entity"), false);
          return;
        }
        let relatedRules = 0;
        try {
          const rulesData = await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/entities/${encodeURIComponent(entity.id)}/rules`);
          relatedRules = (rulesData.values || []).length;
        } catch (_err) {
          relatedRules = trustRules.filter((rule) => rule.entityId === entity.id).length;
        }
        if (!window.confirm(formatText("aiadmin-confirm-delete-entity", {
          name: entity.name,
          id: entity.id,
          rules: relatedRules,
        }))) return;
        const data = await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/entities/${encodeURIComponent(entity.id)}`, {
          method: "DELETE",
        });
        selectedTrustEntityId = null;
        selectedTrustRuleId = null;
        selectedTrustPolicyRowId = null;
        await renderTrustEntities(modelId);
        statusText("aiadmin-trust-entity-status", formatText("aiadmin-message-deleted-with-count", {
          count: data.values?.deletedRuleCount ?? 0,
        }));
      };

      const deleteSelectedTrustRule = async () => {
        const modelId = selectedTrustModelId();
        const row = selectedTrustPolicyRow();
        if (!modelId || !row) {
          statusText("aiadmin-trust-rule-status", t("aiadmin-empty-no-trust-rules"), false);
          return;
        }
        if (row.source === "entity") {
          const relatedRules = trustRules.filter((rule) => rule.entityId === row.rawId).length;
          if (!window.confirm(formatText("aiadmin-confirm-delete-entity", {
            name: row.name,
            id: row.legacyId || row.rawId,
            rules: relatedRules,
          }))) return;
          await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/entities/${encodeURIComponent(row.rawId)}`, {
            method: "DELETE",
          });
          statusText("aiadmin-trust-rule-status", formatText("aiadmin-message-deleted-with-count", {
            count: relatedRules,
          }));
        } else {
          if (!window.confirm(formatText("aiadmin-confirm-delete-rule", {
            name: row.name,
            id: row.id,
          }))) return;
          await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/rules/${encodeURIComponent(row.rawId)}`, {
            method: "DELETE",
          });
          statusText("aiadmin-trust-rule-status", t("aiadmin-message-deleted"));
        }
        selectedTrustRuleId = null;
        selectedTrustEntityId = null;
        selectedTrustPolicyRowId = null;
        await renderTrustEntities(modelId);
      };

      const trustPreviewListConfigs = {
        categories: {
          inputId: "trust-preview-categories",
          searchId: "trust-preview-categories-search",
          chipsId: "trust-preview-categories-chips",
          normalize: normalizeCategoryFilterValue,
        },
        tags: {
          inputId: "trust-preview-tags",
          searchId: "trust-preview-tags-search",
          chipsId: "trust-preview-tags-chips",
          normalize: normalizeTextValue,
        },
        authorGroups: {
          inputId: "trust-preview-author-groups",
          searchId: "trust-preview-author-groups-search",
          chipsId: "trust-preview-author-groups-chips",
          normalize: normalizeTextValue,
        },
        templates: {
          inputId: "trust-preview-templates",
          searchId: "trust-preview-templates-search",
          chipsId: "trust-preview-templates-chips",
          normalize: normalizeTextValue,
        },
      };

      const getTrustPreviewListValues = (key) => {
        const config = trustPreviewListConfigs[key];
        const input = document.getElementById(config.inputId);
        return uniqueTextValues(parseCsv(input?.value || ""), config.normalize);
      };

      const renderTrustPreviewList = (key) => {
        const config = trustPreviewListConfigs[key];
        const root = document.getElementById(config.chipsId);
        if (!root) return;
        root.innerHTML = "";
        const values = getTrustPreviewListValues(key);
        if (values.length === 0) {
          root.textContent = t("aiadmin-value-none");
          return;
        }
        values.forEach((value) => {
          const chip = document.createElement("span");
          chip.className = "ai-admin-chip";
          const text = document.createElement("span");
          text.textContent = value;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "×";
          remove.setAttribute("aria-label", `${t("aiadmin-action-remove")} ${value}`);
          remove.addEventListener("click", () => {
            setTrustPreviewListValues(key, getTrustPreviewListValues(key).filter((item) => item !== value));
          });
          chip.append(text, remove);
          root.appendChild(chip);
        });
      };

      const setTrustPreviewListValues = (key, values) => {
        const config = trustPreviewListConfigs[key];
        const input = document.getElementById(config.inputId);
        if (!input) return;
        input.value = uniqueTextValues(values, config.normalize).join(", ");
        renderTrustPreviewList(key);
      };

      const addTrustPreviewListValue = (key) => {
        const config = trustPreviewListConfigs[key];
        const search = document.getElementById(config.searchId);
        const value = config.normalize(search?.value || "");
        if (!value) return;
        setTrustPreviewListValues(key, [...getTrustPreviewListValues(key), value]);
        search.value = "";
      };

      const renderTrustPreviewLists = () => {
        Object.keys(trustPreviewListConfigs).forEach(renderTrustPreviewList);
      };

      const collectTrustPreview = () => ({
        title: document.getElementById("trust-preview-title").value.trim(),
        namespace: Number(document.getElementById("trust-preview-namespace").value),
        categories: parseCsv(document.getElementById("trust-preview-categories").value),
        tags: parseCsv(document.getElementById("trust-preview-tags").value),
        authorGroups: parseCsv(document.getElementById("trust-preview-author-groups").value),
        templates: parseCsv(document.getElementById("trust-preview-templates").value),
        lastModified: document.getElementById("trust-preview-last-modified").value.trim() || undefined,
        properties: JSON.parse(document.getElementById("trust-preview-properties").value || "{}"),
      });

      const renderTrustPreview = async () => {
        const modelId = selectedTrustModelId();
        const root = document.getElementById("aiadmin-trust-preview-result");
        root.textContent = t("aiadmin-message-generating");
        const data = await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/preview`, {
          method: "POST",
          body: JSON.stringify(collectTrustPreview()),
        });
        const values = data.values || {};
        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-score",
          "aiadmin-field-last-modified",
          "aiadmin-table-age-years",
          "aiadmin-table-staleness-penalty",
          "aiadmin-table-flags",
          "aiadmin-table-decisions",
          "aiadmin-table-applied"
        ]);
        const row = document.createElement("tr");
        [
          values.score,
          values.lastModified || "",
          values.ageYears ?? "",
          values.stalenessPenalty,
          (values.flags || []).join(", "),
          Object.entries(values.decisions || {}).map(([key, value]) => `${key}=${value}`).join("; "),
          `entities=${(values.appliedEntities || []).map((item) => item.name).join(", ")}; rules=${(values.appliedRules || []).map((item) => item.name).join(", ")}`,
        ].forEach((cellValue) => {
          const cell = document.createElement("td");
          cell.textContent = String(cellValue ?? "");
          row.appendChild(cell);
        });
        table.querySelector("tbody").appendChild(row);
        root.innerHTML = "";
        root.appendChild(table);
      };

      const renderTrustRecalculation = async () => {
        const root = document.getElementById("aiadmin-trust-recalc-result");
        root.textContent = t("aiadmin-message-running");
        const data = await request("/api/admin/trust-scores/recalculate", {
          method: "POST",
          body: JSON.stringify({
            modelId: selectedTrustModelId(),
            dryRun: document.getElementById("trust-recalc-dryrun").checked,
            maxScan: Number(document.getElementById("trust-recalc-maxscan").value),
            batchSize: Number(document.getElementById("trust-recalc-batchsize").value),
          }),
        });
        const values = data.values || {};
        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-collection",
          "aiadmin-table-model",
          "aiadmin-table-dry-run",
          "aiadmin-table-scanned",
          "aiadmin-table-eligible",
          "aiadmin-table-updated",
          "aiadmin-table-failed"
        ]);
        const row = document.createElement("tr");
        [
          values.collection,
          values.modelId,
          yesNo(values.dryRun),
          values.scannedPoints,
          values.eligiblePoints,
          values.updatedPoints,
          values.failedPoints,
        ].forEach((cellValue) => {
          const cell = document.createElement("td");
          cell.textContent = String(cellValue ?? "");
          row.appendChild(cell);
        });
        table.querySelector("tbody").appendChild(row);
        root.innerHTML = "";
        root.appendChild(table);
        const sample = document.createElement("pre");
        sample.textContent = JSON.stringify(values.sample || [], null, 2);
        root.appendChild(sample);
      };

      const renderTrustSchedule = async () => {
        const data = await request("/api/admin/trust-recalculation/config");
        const values = data.values || {};
        const scheduler = data.scheduler || {};
        document.getElementById("trust-schedule-enabled").checked = Boolean(values.enabled);
        document.getElementById("trust-schedule-interval").value = values.intervalMinutes || 1440;
        document.getElementById("trust-schedule-maxscan").value = values.maxScan || 1000;
        document.getElementById("trust-schedule-batchsize").value = values.batchSize || 128;
        document.getElementById("aiadmin-trust-schedule-result").textContent =
          formatText("aiadmin-status-schedule-line", {
            running: yesNo(scheduler.running),
            next: scheduler.nextRunAt || "",
            last: scheduler.lastFinishedAt || "",
            error: scheduler.lastError || ""
          });
      };

      const collectTrustSchedule = () => ({
        enabled: document.getElementById("trust-schedule-enabled").checked,
        intervalMinutes: Number(document.getElementById("trust-schedule-interval").value),
        maxScan: Number(document.getElementById("trust-schedule-maxscan").value),
        batchSize: Number(document.getElementById("trust-schedule-batchsize").value),
      });

      const renderConflictDetectionConfig = async () => {
        const data = await request("/api/admin/conflict-detection/config");
        conflictDetectionConfig = data.values || {};
        const form = document.getElementById("aiadmin-conflict-detection-form");
        form.innerHTML = "";
        appendCheckboxRow(form, "conflict-enabled", t("aiadmin-field-conflict-enabled"), conflictDetectionConfig.enabled);
        appendSelectRow(form, "conflict-runmode", t("aiadmin-field-conflict-run-mode"), conflictDetectionConfig.runMode, [
          { value: "risk_only", label: t("aiadmin-value-conflict-mode-risk-only") },
          { value: "always", label: t("aiadmin-value-conflict-mode-always") },
          { value: "manual", label: t("aiadmin-value-conflict-mode-manual") },
        ]);
        appendInputRow(form, "conflict-model", t("aiadmin-field-conflict-model"), conflictDetectionConfig.model);
        appendInputRow(form, "conflict-max-sources", t("aiadmin-field-conflict-max-sources"), conflictDetectionConfig.maxSources, { type: "number", min: 2, max: 10 });
        appendInputRow(form, "conflict-max-chars", t("aiadmin-field-conflict-max-chars-source"), conflictDetectionConfig.maxCharsPerSource, { type: "number", min: 300, max: 12000 });
        appendInputRow(form, "conflict-trust-gap", t("aiadmin-field-conflict-trust-gap"), conflictDetectionConfig.trustGapThreshold, { type: "number", min: 0, max: 1, step: "0.01" });
        appendInputRow(form, "conflict-confidence", t("aiadmin-field-conflict-confidence"), conflictDetectionConfig.lowConfidenceThreshold, { type: "number", min: 0, max: 1, step: "0.01" });
        appendCheckboxRow(form, "conflict-show-block", t("aiadmin-field-conflict-show-block"), conflictDetectionConfig.showConflictBlock);
      };

      const collectConflictDetectionConfig = () => ({
        enabled: document.getElementById("conflict-enabled").checked,
        runMode: document.getElementById("conflict-runmode").value,
        model: document.getElementById("conflict-model").value.trim(),
        maxSources: Number(document.getElementById("conflict-max-sources").value),
        maxCharsPerSource: Number(document.getElementById("conflict-max-chars").value),
        trustGapThreshold: Number(document.getElementById("conflict-trust-gap").value),
        lowConfidenceThreshold: Number(document.getElementById("conflict-confidence").value),
        showConflictBlock: document.getElementById("conflict-show-block").checked,
      });

      const renderConflictDetectionTest = (values) => {
        const root = document.getElementById("aiadmin-conflict-detection-test");
        root.innerHTML = "";
        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-status",
          "aiadmin-table-confidence",
          "aiadmin-table-model",
          "aiadmin-table-source",
          "aiadmin-table-details"
        ]);
        const row = document.createElement("tr");
        [
          values.hasConflict ? t("aiadmin-value-yes") : t("aiadmin-value-no"),
          `${Math.round(Number(values.confidence || 0) * 100)}%`,
          values.metadata?.model || "",
          `${values.metadata?.sourceCount ?? 0}`,
          values.summary || values.lowTrustReason || "",
        ].forEach((cellValue) => {
          const cell = document.createElement("td");
          cell.textContent = String(cellValue ?? "");
          row.appendChild(cell);
        });
        table.querySelector("tbody").appendChild(row);
        root.appendChild(table);

        if ((values.conflictingSources || []).length > 0) {
          const list = document.createElement("ul");
          values.conflictingSources.forEach((source) => {
            const item = document.createElement("li");
            item.textContent = `${source.title}: ${source.claim || source.status || ""}`;
            list.appendChild(item);
          });
          root.appendChild(list);
        }
      };

      const renderIndexingSchedulerStatus = async () => {
        const root = document.getElementById("aiadmin-indexing-scheduler");
        const data = await request("/api/admin/indexing-profile-scheduler/status");
        const scheduler = data.scheduler || {};
        const profiles = scheduler.profiles || [];
        root.innerHTML = "";
        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-scheduled-profile",
          "aiadmin-table-interval",
          "aiadmin-table-running",
          "aiadmin-table-next",
          "aiadmin-table-last",
          "aiadmin-table-error"
        ]);
        const tbody = table.querySelector("tbody");
        if (profiles.length === 0) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 6;
          cell.textContent = t("aiadmin-empty-no-scheduled-profiles");
          row.appendChild(cell);
          tbody.appendChild(row);
        }
        profiles.forEach((profile) => {
          const row = document.createElement("tr");
          [
            `${profile.name} (${profile.id})`,
            `${profile.intervalMinutes} min`,
            yesNo(profile.running),
            profile.nextRunAt || "",
            profile.lastFinishedAt || profile.lastStartedAt || "",
            profile.lastError || "",
          ].forEach((cellValue) => {
            const cell = document.createElement("td");
            cell.textContent = String(cellValue);
            row.appendChild(cell);
          });
          tbody.appendChild(row);
        });
        root.appendChild(table);
      };

      const renderIndexingProfiles = async () => {
        if (ontologyProperties.length === 0) {
          await loadOntologyProperties();
        }
        const data = await request("/api/admin/indexing-profiles");
        indexingProfiles = data.values || [];
        const root = document.getElementById("aiadmin-indexing-profiles");
        const select = document.getElementById("aiadmin-reindex-profile");
        root.innerHTML = "";
        select.innerHTML = "";

        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-id",
          "aiadmin-table-name",
          "aiadmin-table-namespaces",
          "aiadmin-table-filters",
          "aiadmin-table-chunking",
          "aiadmin-table-defaults"
        ]);
        const tbody = table.querySelector("tbody");
        indexingProfiles.forEach((profile) => {
          const option = document.createElement("option");
          option.value = profile.id;
          option.textContent = `${profile.name} (${profile.id})`;
          select.appendChild(option);

          const row = document.createElement("tr");
          [
            profile.id,
            profile.name,
            (profile.namespaces || []).join(", "),
            `title +${(profile.titleFilters?.include || []).join("|")} -${(profile.titleFilters?.exclude || []).join("|")}; category +${(profile.categoryFilters?.include || []).join("|")} -${(profile.categoryFilters?.exclude || []).join("|")}`,
            `${profile.chunkSize}/${profile.chunkOverlap}`,
            `maxPages=${profile.maxPagesDefault ?? t("aiadmin-value-none")}; dryRun=${yesNo(profile.dryRunDefault)}; attachments=${yesNo(profile.attachmentsEnabled)}; semantic=${yesNo(profile.semanticFactsEnabled)}; run=${profile.runMode || "manual"}`,
          ].forEach((cellValue) => {
            const cell = document.createElement("td");
            cell.textContent = String(cellValue);
            row.appendChild(cell);
          });
          tbody.appendChild(row);
        });
        root.appendChild(table);

        const first = indexingProfiles[0];
        if (first) {
          document.getElementById("idx-profile-id").value = first.id;
          document.getElementById("idx-profile-name").value = first.name;
          document.getElementById("idx-profile-namespaces").value = (first.namespaces || []).join(", ");
          updateIndexingPropertiesSummary();
          document.getElementById("idx-profile-title-include").value = (first.titleFilters?.include || []).join(", ");
          document.getElementById("idx-profile-title-exclude").value = (first.titleFilters?.exclude || []).join(", ");
          setCategoryFilterValues("include", first.categoryFilters?.include || []);
          setCategoryFilterValues("exclude", first.categoryFilters?.exclude || []);
          document.getElementById("idx-profile-document-policy").value = first.documentPolicyId || "default";
          document.getElementById("idx-profile-runmode").value = first.runMode || "manual";
          document.getElementById("idx-profile-schedule").value = first.scheduleIntervalMinutes || "";
          document.getElementById("idx-profile-maxpages").value = first.maxPagesDefault ?? "";
          document.getElementById("idx-profile-chunksize").value = first.chunkSize || "";
          document.getElementById("idx-profile-overlap").value = first.chunkOverlap || "";
          document.getElementById("idx-profile-attachments").checked = Boolean(first.attachmentsEnabled);
          document.getElementById("idx-profile-semantics").checked = Boolean(first.semanticFactsEnabled);
          document.getElementById("idx-profile-dryrun").checked = Boolean(first.dryRunDefault);
        }
      };

      const collectIndexingProfile = () => {
        const maxPages = document.getElementById("idx-profile-maxpages").value.trim();
        const schedule = document.getElementById("idx-profile-schedule").value.trim();
        const id = document.getElementById("idx-profile-id").value.trim();
        const profile = {
          name: document.getElementById("idx-profile-name").value.trim(),
          namespaces: parseNumberCsv(document.getElementById("idx-profile-namespaces").value),
          titleFilters: {
            include: parseCsv(document.getElementById("idx-profile-title-include").value),
            exclude: parseCsv(document.getElementById("idx-profile-title-exclude").value),
          },
          categoryFilters: {
            include: getCategoryFilterValues("include"),
            exclude: getCategoryFilterValues("exclude"),
          },
          documentPolicyId: document.getElementById("idx-profile-document-policy").value.trim() || "default",
          runMode: document.getElementById("idx-profile-runmode").value,
          attachmentsEnabled: document.getElementById("idx-profile-attachments").checked,
          semanticFactsEnabled: document.getElementById("idx-profile-semantics").checked,
          dryRunDefault: document.getElementById("idx-profile-dryrun").checked,
          ontologyVectorsEnabled: false,
          chunkSize: Number(document.getElementById("idx-profile-chunksize").value),
          chunkOverlap: Number(document.getElementById("idx-profile-overlap").value),
          chunkSeparators: ragConfig?.chunkSeparators || ["\\n## ", "\\n### ", "\\n\\n", "\\n", ". ", " "],
          maxPagesDefault: maxPages ? Number(maxPages) : null,
        };
        if (id) profile.id = id;
        if (schedule) profile.scheduleIntervalMinutes = Number(schedule);
        return profile;
      };

      const renderAuditLog = async () => {
        const root = document.getElementById("aiadmin-audit-log");
        root.textContent = t("aiadmin-loading");
        try {
          const data = await request("/api/admin/audit-log?limit=30");
          const rows = data.values || [];
          const table = document.createElement("table");
          table.className = "ai-admin-table";
          table.innerHTML = tableHtml([
            "aiadmin-table-id",
            "aiadmin-table-action",
            "aiadmin-table-entity",
            "aiadmin-table-actor",
            "aiadmin-table-created"
          ]);
          const tbody = table.querySelector("tbody");
          rows.forEach((entry) => {
            const row = document.createElement("tr");
            [entry.id, entry.action, entry.entityId, entry.actor || "", entry.createdAt].forEach((cellValue) => {
              const cell = document.createElement("td");
              cell.textContent = String(cellValue ?? "");
              row.appendChild(cell);
            });
            tbody.appendChild(row);
          });
          root.innerHTML = "";
          root.appendChild(table);
        } catch (err) {
          root.textContent = err.message;
          root.className = "ai-admin-status-error";
        }
      };

      const renderDocumentPolicy = () => {
        const root = document.getElementById("aiadmin-document-policy");
        root.innerHTML = "";
        const enabled = document.createElement("div");
        enabled.className = "ai-admin-row";
        const enabledLabel = document.createElement("label");
        enabledLabel.htmlFor = "doc-attachments-enabled";
        enabledLabel.textContent = t("aiadmin-field-index-attachments");
        const enabledInput = document.createElement("input");
        enabledInput.id = "doc-attachments-enabled";
        enabledInput.type = "checkbox";
        enabledInput.checked = Boolean(documentPolicy.attachmentsEnabled);
        enabled.append(enabledLabel, enabledInput);
        root.appendChild(enabled);

        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-mime",
          "aiadmin-table-mode",
          "aiadmin-table-ocr-languages",
          "aiadmin-table-max-bytes",
          "aiadmin-table-actions"
        ]);
        const tbody = table.querySelector("tbody");
        Object.entries(documentPolicy.mimeTypes || {}).sort(([a], [b]) => a.localeCompare(b)).forEach(([mime, rule]) => {
          const row = document.createElement("tr");
          row.dataset.mime = mime;
          const mimeCell = document.createElement("td");
          const mimeCode = document.createElement("code");
          mimeCode.textContent = mime;
          mimeCell.appendChild(mimeCode);
          const modeCell = document.createElement("td");
          const modeSelect = document.createElement("select");
          modeSelect.className = "doc-mode";
          ["disabled", "metadata", "text", "ocr"].forEach((mode) => {
            const option = document.createElement("option");
            option.value = mode;
            option.textContent = mode;
            option.selected = rule.mode === mode;
            modeSelect.appendChild(option);
          });
          modeCell.appendChild(modeSelect);
          const ocrCell = document.createElement("td");
          const ocrInput = document.createElement("input");
          ocrInput.className = "doc-ocr";
          ocrInput.type = "text";
          ocrInput.value = rule.ocrLanguages || "";
          ocrInput.placeholder = "eng+rus";
          ocrCell.appendChild(ocrInput);
          const maxCell = document.createElement("td");
          const maxInput = document.createElement("input");
          maxInput.className = "doc-max";
          maxInput.type = "number";
          maxInput.min = "1";
          maxInput.value = rule.maxBytes || "";
          maxCell.appendChild(maxInput);
          const actionCell = document.createElement("td");
          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.className = "ai-admin-btn doc-remove";
          removeButton.textContent = t("aiadmin-action-remove");
          removeButton.addEventListener("click", () => {
            delete documentPolicy.mimeTypes[mime];
            renderDocumentPolicy();
          });
          actionCell.appendChild(removeButton);
          row.append(mimeCell, modeCell, ocrCell, maxCell, actionCell);
          tbody.appendChild(row);
        });
        root.appendChild(table);
      };

      const loadDocumentPolicy = async () => {
        const data = await request("/api/admin/document-processing");
        documentPolicy = data.values || { attachmentsEnabled: true, mimeTypes: {} };
        renderDocumentPolicy();
      };

      const ontologyTemplateForName = (name) => ontologyPropertyTemplates[String(name || "").trim()] || null;
      const ontologyPropertyByName = (name) => ontologyProperties.find((property) => property.name === name) || null;
      const smwPropertyByName = (name) => smwPropertyCatalog.find((property) => property.name === name) || null;
      const selectedOntologyName = () => document.getElementById("ontology-name").value.trim();
      const selectedOntologyId = () => {
        const name = selectedOntologyName();
        return selectedOntologyPropertyId || ontologyPropertyByName(name)?.id || "";
      };

      const normalizeSmwDataType = (value) => {
        const type = String(value || "").trim();
        return type && type !== "Unknown" ? type : "text";
      };

      const mergeSmwPropertyCatalog = (existing, incoming) => {
        const byName = new Map();
        [...existing, ...incoming].forEach((property) => {
          if (property?.name) byName.set(property.name, property);
        });
        return Array.from(byName.values()).sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "ru"));
      };

      const renderSmwPropertyCatalogStatus = () => {
        ["aiadmin-smw-properties-status"].forEach((statusId) => {
          const node = document.getElementById(statusId);
          if (!node) return;
          node.textContent = formatText("aiadmin-status-smw-properties-loaded", {
            count: smwPropertyCatalog.length,
            search: smwPropertyCatalogSearch || t("aiadmin-value-none"),
            more: smwPropertyCatalogNextContinue ? yesNo(true) : yesNo(false),
          });
        });
        ["aiadmin-load-more-smw-properties"].forEach((buttonId) => {
          const moreButton = document.getElementById(buttonId);
          if (moreButton) moreButton.disabled = !smwPropertyCatalogNextContinue;
        });
      };

      const loadSmwPropertyCatalog = async (options = {}) => {
        const force = Boolean(options.force);
        const append = Boolean(options.append);
        const search = String(options.search ?? smwPropertyCatalogSearch ?? "").trim();
        if (smwPropertyCatalogLoaded && !force && !append && search === smwPropertyCatalogSearch) {
          renderSmwPropertyCatalogStatus();
          return smwPropertyCatalog;
        }
        const params = new URLSearchParams({ limit: "100" });
        if (search) params.set("search", search);
        if (append && smwPropertyCatalogNextContinue) params.set("continue", smwPropertyCatalogNextContinue);
        try {
          const data = await request(`/api/admin/smw/properties?${params.toString()}`);
          smwPropertyCatalog = append
            ? mergeSmwPropertyCatalog(smwPropertyCatalog, data.values || [])
            : mergeSmwPropertyCatalog([], data.values || []);
          smwPropertyCatalogNextContinue = data.nextContinue || null;
          smwPropertyCatalogSearch = search;
          smwPropertyCatalogLoaded = true;
          populateOntologyPropertySelect();
          renderSmwPropertyCatalogStatus();
          return smwPropertyCatalog;
        } catch (err) {
          throw new Error(formatText("aiadmin-error-smw-properties-route", { error: err.message }, err.message));
        }
      };

      const populateOntologyPropertySelect = () => {
        const select = document.getElementById("ontology-name");
        if (!select) return;
        const current = select.value;
        select.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("aiadmin-placeholder-select-smw-property");
        select.appendChild(placeholder);
        mergeSmwPropertyCatalog(smwPropertyCatalog, ontologyProperties.map((property) => ({
          name: property.name,
          title: `Свойство:${property.name}`,
          type: property.dataType || "Unknown",
          description: property.description,
        }))).forEach((property) => {
          const option = document.createElement("option");
          option.value = property.name;
          option.textContent = `${property.name} (${property.type || "Unknown"})`;
          select.appendChild(option);
        });
        if (current && Array.from(select.options).some((option) => option.value === current)) {
          select.value = current;
        }
      };

      const updateOntologyDerivedSummary = () => {
        const node = document.getElementById("ontology-derived-summary");
        if (!node) return;
        const name = selectedOntologyName();
        const meta = smwPropertyByName(name);
        const stored = ontologyPropertyByName(name);
        if (!name) {
          node.textContent = t("aiadmin-error-select-smw-property");
          return;
        }
        node.textContent = formatText("aiadmin-status-ontology-derived", {
          type: meta?.type || stored?.dataType || "Unknown",
          sensitive: yesNo(Boolean(stored?.sensitive)),
        });
      };

      const applyOntologyTemplate = () => {
        const nameInput = document.getElementById("ontology-name");
        const descriptionInput = document.getElementById("ontology-description");
        const promptInput = document.getElementById("ontology-prompt");
        const template = ontologyTemplateForName(nameInput.value);
        if (!template) return;
        if (!descriptionInput.value.trim()) descriptionInput.value = template.description;
        if (!promptInput.value.trim()) promptInput.value = template.prompt;
      };

      const resetOntologyForm = () => {
        selectedOntologyPropertyId = null;
        document.getElementById("ontology-name").value = "";
        document.getElementById("ontology-description").value = "";
        document.getElementById("ontology-prompt").value = "";
        document.getElementById("ontology-threshold").value = 0.7;
        document.getElementById("ontology-indexed").checked = true;
        document.getElementById("ontology-extractable").checked = true;
        updateOntologyDerivedSummary();
        renderOntologyPropertyRows();
      };

      const fillOntologyForm = (property) => {
        selectedOntologyPropertyId = property?.id || null;
        const template = ontologyTemplateForName(property?.name);
        document.getElementById("ontology-name").value = property?.name || "";
        document.getElementById("ontology-description").value = property?.description || template?.description || "";
        document.getElementById("ontology-prompt").value = property?.aiPromptHint || template?.prompt || "";
        document.getElementById("ontology-threshold").value = property?.classificationThreshold ?? 0.7;
        document.getElementById("ontology-indexed").checked = property?.indexed !== false;
        document.getElementById("ontology-extractable").checked = property?.aiExtractable !== false;
        updateOntologyDerivedSummary();
        renderOntologyPropertyRows();
      };

      const fillOntologyFormByName = (name) => {
        const existing = ontologyPropertyByName(name);
        if (existing) {
          fillOntologyForm(existing);
          return;
        }
        selectedOntologyPropertyId = null;
        document.getElementById("ontology-name").value = name;
        const meta = smwPropertyByName(name);
        const template = ontologyTemplateForName(name);
        document.getElementById("ontology-description").value = meta?.description || template?.description || "";
        document.getElementById("ontology-prompt").value = template?.prompt || "";
        document.getElementById("ontology-threshold").value = 0.7;
        document.getElementById("ontology-indexed").checked = true;
        document.getElementById("ontology-extractable").checked = true;
        updateOntologyDerivedSummary();
        renderOntologyPropertyRows();
      };

      const loadOntologyProperties = async () => {
        const data = await request("/api/admin/smw/ontology");
        ontologyProperties = data.values || [];
        renderTrustRulePropertyOptions();
        renderTrustEntityValueOptions();
        return ontologyProperties;
      };

      const loadSemanticPropertyValues = async () => {
        if (semanticPropertyValuesLoaded) return semanticPropertyValues;
        const data = await request("/api/admin/semantic/status?maxScan=10000");
        const properties = data.values?.properties || {};
        semanticPropertyValues = {};
        Object.entries(properties).forEach(([property, stats]) => {
          const values = Array.isArray(stats?.values)
            ? stats.values.map((value) => String(value || "").trim()).filter(Boolean)
            : [];
          semanticPropertyValues[property] = Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
        });
        semanticPropertyValuesLoaded = true;
        renderTrustRulePropertyOptions();
        renderTrustRuleValueOptions();
        return semanticPropertyValues;
      };

      const indexedOntologyPropertyNames = () => ontologyProperties
        .filter((property) => property.indexed !== false)
        .map((property) => property.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));

      const updateIndexingPropertiesSummary = () => {
        const node = document.getElementById("idx-profile-properties");
        if (!node) return;
        const properties = indexedOntologyPropertyNames();
        node.textContent = formatText("aiadmin-status-indexed-smw-properties", {
          count: properties.length,
          properties: properties.length > 0 ? properties.join(", ") : t("aiadmin-value-none")
        });
      };

      const ontologyVectorText = (property) => {
        const vector = property.vector || {};
        const pieces = [
          vector.status || "missing",
          vector.dimension ? `${vector.dimension}d` : "",
          vector.model || "",
          vector.generatedAt || "",
        ].filter(Boolean);
        return pieces.join("; ");
      };

      const ontologyVectorSourcePreview = (property) => {
        const source = property.vector?.sourceText || "";
        if (!source) return "";
        return source.length > 180 ? `${source.slice(0, 180)}...` : source;
      };

      const renderSelectedOntologyPropertySummary = () => {
        const node = document.getElementById("aiadmin-selected-ontology-property");
        if (!node) return;
        const property = ontologyProperties.find((item) => item.id === selectedOntologyPropertyId);
        if (!property) {
          node.textContent = t("aiadmin-status-ontology-no-selection");
          return;
        }
        const name = property.label || property.name || property.id;
        const meta = smwPropertyByName(property.name);
        node.textContent = formatText("aiadmin-status-ontology-selected", {
          property: `${name} (${property.name || property.id})`,
          type: meta?.type || property.dataType || "text",
          vector: ontologyVectorText(property) || "missing",
        });
      };

      const renderOntologyPropertyRows = () => {
        const tbody = document.querySelector("#aiadmin-ontology-properties table tbody");
        if (!tbody) {
          renderSelectedOntologyPropertySummary();
          return;
        }
        tbody.innerHTML = "";
        ontologyProperties.forEach((property) => {
          const row = document.createElement("tr");
          row.className = "ai-admin-clickable-row";
          row.classList.toggle("ai-admin-row-selected", property.id === selectedOntologyPropertyId);
          row.title = t("aiadmin-help-ontology-actions");
          row.addEventListener("click", () => fillOntologyForm(property));
          const meta = smwPropertyByName(property.name);
          [
            property.name,
            meta?.type || property.dataType,
            yesNo(Boolean(property.sensitive)),
            yesNo(property.indexed !== false),
            yesNo(property.aiExtractable),
            ontologyVectorText(property),
            ontologyVectorSourcePreview(property),
            property.updatedAt,
          ].forEach((cellValue) => {
            const cell = document.createElement("td");
            cell.textContent = String(cellValue ?? "");
            row.appendChild(cell);
          });
          tbody.appendChild(row);
        });
        renderSelectedOntologyPropertySummary();
      };

      const renderOntologyProperties = async () => {
        const root = document.getElementById("aiadmin-ontology-properties");
        await Promise.all([loadOntologyProperties(), loadSmwPropertyCatalog()]);
        root.innerHTML = "";
        const help = document.createElement("div");
        help.className = "ai-admin-muted";
        help.textContent = t("aiadmin-help-ontology-actions");
        root.appendChild(help);
        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-property",
          "aiadmin-table-type",
          "aiadmin-table-sensitive",
          "aiadmin-table-indexed",
          "aiadmin-table-extract",
          "aiadmin-table-vector",
          "aiadmin-table-vector-source",
          "aiadmin-table-updated"
        ]);
        root.appendChild(table);
        const selectedSummary = document.createElement("div");
        selectedSummary.id = "aiadmin-selected-ontology-property";
        selectedSummary.className = "ai-admin-muted";
        selectedSummary.title = t("aiadmin-help-ontology-selected");
        selectedSummary.setAttribute("aria-live", "polite");
        root.appendChild(selectedSummary);
        const selected = ontologyProperties.find((property) => property.id === selectedOntologyPropertyId) || ontologyProperties[0];
        if (selected) fillOntologyForm(selected);
        else resetOntologyForm();
        renderOntologyPropertyRows();
        updateIndexingPropertiesSummary();
      };

      const sortedOntologyProperties = () => [...ontologyProperties]
        .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "ru"));

      const collectSensitiveProperty = (property, sensitive) => {
        return {
          id: property.id,
          name: property.name,
          label: property.label,
          description: property.description || "",
          dataType: normalizeSmwDataType(property.dataType),
          format: property.format,
          unit: property.unit,
          indexed: property.indexed !== false,
          aiExtractable: property.aiExtractable !== false,
          aiPromptHint: property.aiPromptHint,
          classificationThreshold: property.classificationThreshold ?? 0.7,
          requiredRight: property.requiredRight,
          sensitive,
        };
      };

      const renderSensitivePropertyRows = () => {
        const tbody = document.querySelector("#aiadmin-sensitive-properties table tbody");
        if (!tbody) return;
        tbody.innerHTML = "";
        sortedOntologyProperties().forEach((property) => {
          const row = document.createElement("tr");
          const sensitiveCell = document.createElement("td");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(property.sensitive);
          checkbox.dataset.propertyId = property.id || "";
          checkbox.dataset.propertyName = property.name || "";
          sensitiveCell.appendChild(checkbox);
          [
            property.name,
            property.dataType || unknown(),
            ontologyVectorText(property) || "missing",
            property.description,
            property.updatedAt,
          ].forEach((cellValue) => {
            const cell = document.createElement("td");
            cell.textContent = String(cellValue ?? "");
            row.appendChild(cell);
          });
          row.appendChild(sensitiveCell);
          tbody.appendChild(row);
        });
      };

      const renderSensitiveProperties = async () => {
        const root = document.getElementById("aiadmin-sensitive-properties");
        await loadOntologyProperties();
        root.innerHTML = "";
        const table = document.createElement("table");
        table.className = "ai-admin-table";
        table.innerHTML = tableHtml([
          "aiadmin-table-property",
          "aiadmin-table-type",
          "aiadmin-table-vector",
          "aiadmin-field-description",
          "aiadmin-table-updated",
          "aiadmin-table-sensitive"
        ]);
        root.appendChild(table);
        if (ontologyProperties.length === 0) {
          const empty = document.createElement("div");
          empty.className = "ai-admin-muted";
          empty.textContent = t("aiadmin-empty-no-sensitive-properties");
          root.appendChild(empty);
        }
        renderSensitivePropertyRows();
      };

      const saveSensitiveProperties = async () => {
        const checkboxes = Array.from(document.querySelectorAll("#aiadmin-sensitive-properties input[type=\"checkbox\"]"));
        for (const checkbox of checkboxes) {
          const property = ontologyProperties.find((item) => item.id === checkbox.dataset.propertyId || item.name === checkbox.dataset.propertyName);
          if (!property || Boolean(property.sensitive) === checkbox.checked) continue;
          await request("/api/admin/smw/ontology", {
            method: "POST",
            body: JSON.stringify(collectSensitiveProperty(property, checkbox.checked)),
          });
        }
        await loadOntologyProperties();
        await renderSensitiveProperties();
        await renderOntologyProperties();
      };

      const collectOntologyProperty = () => {
        applyOntologyTemplate();
        const name = selectedOntologyName();
        const meta = smwPropertyByName(name);
        if (!name || !meta) {
          throw new Error(t("aiadmin-error-select-smw-property"));
        }
        const property = {
          name,
          description: document.getElementById("ontology-description").value.trim(),
          dataType: normalizeSmwDataType(meta.type),
          aiPromptHint: document.getElementById("ontology-prompt").value.trim() || undefined,
          classificationThreshold: Number(document.getElementById("ontology-threshold").value),
          indexed: document.getElementById("ontology-indexed").checked,
          aiExtractable: document.getElementById("ontology-extractable").checked,
        };
        return property;
      };

      const collectOntologyFragment = () => {
        const threshold = Number(document.getElementById("ontology-classify-threshold").value);
        return {
          text: document.getElementById("ontology-fragment").value.trim(),
          threshold: Number.isFinite(threshold) ? threshold : undefined,
          includeSensitive: document.getElementById("ontology-include-sensitive").checked,
        };
      };

      const renderOntologyResult = (values) => {
        const root = document.getElementById("aiadmin-ontology-result");
        root.innerHTML = "";
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(values, null, 2);
        root.appendChild(pre);
      };

      const generateSelectedOntologyVector = async () => {
        const id = selectedOntologyId();
        if (!id) throw new Error(t("aiadmin-error-save-ontology-first"));
        const data = await request(`/api/admin/smw/ontology/${encodeURIComponent(id)}/generate-vector`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        renderOntologyResult(data.values || {});
        selectedOntologyPropertyId = data.values?.id || id;
        await renderOntologyProperties();
        statusText("aiadmin-ontology-status", t("aiadmin-message-vector-generated"));
      };

      const renderSelectedOntologySimilarities = async () => {
        const id = selectedOntologyId();
        const data = await request(`/api/admin/smw/ontology/${encodeURIComponent(id)}/similarities`);
        renderOntologyResult(data.values || {});
        statusText("aiadmin-ontology-status", t("aiadmin-message-similarities-ready"));
      };

      const deleteSelectedOntologyProperty = async () => {
        const id = selectedOntologyId();
        const name = document.getElementById("ontology-name").value.trim() || id;
        if (!id) return;
        if (!window.confirm(formatText("aiadmin-confirm-delete-ontology", { name, id }))) return;
        const data = await request(`/api/admin/smw/ontology/${encodeURIComponent(id)}`, { method: "DELETE" });
        renderOntologyResult(data.values || {});
        selectedOntologyPropertyId = null;
        await renderOntologyProperties();
        await renderIndexingProfiles();
        statusText("aiadmin-ontology-status", t("aiadmin-message-deleted"));
      };

      const renderSemanticStatus = async () => {
        const root = document.getElementById("aiadmin-semantic-status");
        root.textContent = t("aiadmin-loading");
        try {
          const data = await request("/api/admin/semantic/status?maxScan=10000");
          const values = data.values || {};
          root.innerHTML = "";

          const summary = document.createElement("div");
          summary.className = "ai-admin-summary";
          [
            [t("aiadmin-metric-scanned-points"), values.scannedPoints || 0],
            [t("aiadmin-metric-semantic-points"), values.semanticPoints || 0],
            [t("aiadmin-metric-semantic-pages"), values.semanticPages || 0],
            [t("aiadmin-metric-scan-complete"), yesNo(values.scanComplete)],
          ].forEach(([label, value]) => {
            const item = document.createElement("div");
            item.className = "ai-admin-summary-item";
            const strong = document.createElement("strong");
            strong.textContent = String(value);
            const span = document.createElement("span");
            span.textContent = label;
            item.append(strong, span);
            summary.appendChild(item);
          });
          root.appendChild(summary);

          const table = document.createElement("table");
          table.className = "ai-admin-table";
          table.innerHTML = tableHtml([
            "aiadmin-table-property",
            "aiadmin-table-points",
            "aiadmin-table-pages",
            "aiadmin-table-values"
          ]);
          const tbody = table.querySelector("tbody");
          Object.entries(values.properties || {}).sort(([a], [b]) => a.localeCompare(b)).forEach(([property, stats]) => {
            const row = document.createElement("tr");
            const valuesText = Array.isArray(stats.values) ? stats.values.slice(0, 8).join(", ") : "";
            [property, stats.points || 0, stats.pages || 0, valuesText].forEach((cellValue) => {
              const cell = document.createElement("td");
              cell.textContent = String(cellValue);
              row.appendChild(cell);
            });
            tbody.appendChild(row);
          });
          root.appendChild(table);
        } catch (err) {
          root.textContent = err.message;
          root.className = "ai-admin-status-error";
        }
      };

      const renderSemanticSearch = async () => {
        const root = document.getElementById("aiadmin-semantic-search");
        const property = document.getElementById("aiadmin-semantic-property").value.trim();
        const value = document.getElementById("aiadmin-semantic-value").value.trim();
        const namespace = document.getElementById("aiadmin-semantic-namespace").value.trim();
        if (!property) {
          root.textContent = t("aiadmin-error-property-required");
          root.className = "ai-admin-search-results ai-admin-status-error";
          return;
        }

        const params = new URLSearchParams({ property, limit: "20" });
        if (value) params.set("value", value);
        if (namespace) params.set("namespace", namespace);
        root.className = "ai-admin-search-results";
        root.textContent = t("aiadmin-message-searching");

        try {
          const data = await request(`/api/admin/semantic/search?${params.toString()}`);
          const values = data.values || {};
          root.innerHTML = "";

          const summary = document.createElement("div");
          summary.className = "ai-admin-muted";
          summary.textContent = formatText("aiadmin-search-summary", {
            matched: values.matchedPoints || 0,
            returned: values.returnedPages || 0,
            scanned: values.scannedPoints || 0
          });
          root.appendChild(summary);

          const table = document.createElement("table");
          table.className = "ai-admin-table";
          table.innerHTML = tableHtml([
            "aiadmin-table-page",
            "aiadmin-table-namespace",
            "aiadmin-table-matched-values",
            "aiadmin-table-facts"
          ]);
          const tbody = table.querySelector("tbody");
          (values.results || []).forEach((result) => {
            const row = document.createElement("tr");
            const facts = Object.entries(result.semanticFacts || {})
              .map(([name, factValues]) => `${name}: ${Array.isArray(factValues) ? factValues.join(", ") : ""}`)
              .join("\\n");
            [result.title || "", result.namespace || "", (result.matchedValues || []).join(", "), facts].forEach((cellValue, index) => {
              const cell = document.createElement("td");
              if (index === 3) {
                const pre = document.createElement("pre");
                pre.textContent = String(cellValue);
                cell.appendChild(pre);
              } else {
                cell.textContent = String(cellValue);
              }
              row.appendChild(cell);
            });
            tbody.appendChild(row);
          });
          root.appendChild(table);
        } catch (err) {
          root.textContent = err.message;
          root.className = "ai-admin-search-results ai-admin-status-error";
        }
      };

      let reindexStatusPoll = null;

      const stopReindexStatusPolling = () => {
        if (!reindexStatusPoll) return;
        window.clearInterval(reindexStatusPoll);
        reindexStatusPoll = null;
      };

      const isReindexTerminalState = (state) => ["idle", "completed", "failed"].includes(state);

      const renderReindexStatus = async () => {
        const root = document.getElementById("aiadmin-reindex-status");
        try {
          const data = await request("/api/admin/reindex/status");
          const status = data.status || {};
          const progress = status.progress || {};
          const summary = status.summary || {};
          const namespaces = firstDefined(progress.namespaces, summary.namespaces, []);
          const limit = firstDefined(progress.limitApplied, summary.limitApplied);
          const dryRun = firstDefined(progress.dryRun, summary.dryRun);
          root.className = "";
          root.innerHTML = "";

          const line = document.createElement("p");
          line.textContent = formatText("aiadmin-reindex-status-line", {
            state: status.state || unknown(),
            profile: firstDefined(progress.profileId, summary.profileId, unknown()),
            namespaces: Array.isArray(namespaces) && namespaces.length > 0 ? namespaces.join(", ") : unknown(),
            matched: firstDefined(progress.matchedPages, summary.matchedPages, progress.totalPages, summary.totalPages, 0),
            limit: limit === undefined ? t("aiadmin-value-none") : limit,
            total: firstDefined(progress.totalPages, summary.totalPages, 0),
            processed: firstDefined(progress.processed, summary.processed, 0),
            skipped: firstDefined(progress.skipped, summary.skipped, 0),
            failed: firstDefined(progress.failed, summary.failed, 0),
            chunks: firstDefined(progress.totalChunks, summary.totalChunks, 0),
            dryRun: dryRun === undefined ? unknown() : yesNo(dryRun)
          });
          line.className = status.state === "failed" ? "ai-admin-status-error" : "ai-admin-status-ok";
          root.appendChild(line);

          const currentTitle = firstDefined(progress.currentTitle, summary.currentTitle);
          if (currentTitle) {
            const current = document.createElement("div");
            current.className = "ai-admin-muted";
            current.textContent = formatText("aiadmin-reindex-current-title", { title: currentTitle });
            root.appendChild(current);
          }

          if (status.error) {
            const error = document.createElement("div");
            error.className = "ai-admin-status-error";
            error.textContent = status.error;
            root.appendChild(error);
          }
          const counters = document.createElement("div");
          counters.className = "ai-admin-muted";
          counters.textContent = formatText("aiadmin-reindex-paid-counters", {
            embeddings: firstDefined(progress.embeddingCalls, summary.embeddingCalls, 0),
            enrichment: firstDefined(progress.llmEnrichmentCalls, summary.llmEnrichmentCalls, 0),
            estimated: firstDefined(progress.estimatedPaidCalls, summary.estimatedPaidCalls, 0)
          });
          root.appendChild(counters);
          return status.state || "idle";
        } catch (err) {
          root.className = "ai-admin-status-error";
          root.textContent = err.message;
          return "failed";
        }
      };

      const startReindexStatusPolling = async () => {
        stopReindexStatusPolling();
        const state = await renderReindexStatus();
        if (isReindexTerminalState(state)) return;
        reindexStatusPoll = window.setInterval(async () => {
          const nextState = await renderReindexStatus();
          if (isReindexTerminalState(nextState)) stopReindexStatusPolling();
        }, 3000);
      };

      const startReindex = async () => {
        const maxPagesValue = document.getElementById("aiadmin-reindex-maxpages").value.trim();
        const body = {
          profileId: document.getElementById("aiadmin-reindex-profile").value,
          attachmentsEnabled: document.getElementById("aiadmin-reindex-attachments").checked,
          dryRun: document.getElementById("aiadmin-reindex-dryrun").checked,
          llmEnrichmentEnabled: document.getElementById("aiadmin-reindex-llm-enrichment").checked,
        };
        if (maxPagesValue) body.maxPages = Number(maxPagesValue);
        const llmModel = document.getElementById("aiadmin-reindex-llm-model").value.trim();
        const llmMaxChars = document.getElementById("aiadmin-reindex-llm-maxchars").value.trim();
        if (llmModel) body.llmEnrichmentModel = llmModel;
        if (llmMaxChars) body.llmEnrichmentMaxChars = Number(llmMaxChars);

        await request("/api/admin/reindex", { method: "POST", body: JSON.stringify(body) });
        await startReindexStatusPolling();
      };

      const collectDocumentPolicy = () => {
        const mimeTypes = {};
        document.querySelectorAll("#aiadmin-document-policy tbody tr").forEach((row) => {
          const mime = row.dataset.mime;
          const maxBytes = row.querySelector(".doc-max").value;
          const rule = {
            mode: row.querySelector(".doc-mode").value,
            ocrLanguages: row.querySelector(".doc-ocr").value || undefined,
          };
          if (maxBytes) rule.maxBytes = Number(maxBytes);
          mimeTypes[mime] = rule;
        });
        return {
          attachmentsEnabled: document.getElementById("doc-attachments-enabled").checked,
          mimeTypes
        };
      };

      const loadTrustReferenceOptions = async (field, search = "", statusId = "aiadmin-trust-rule-status") => {
        try {
          if (field === "namespace" && namespaceOptions.length === 0) return await loadNamespaceOptions();
          if (field === "category") return await loadCategoryOptions(search);
          if (field === "tag") return await loadTagOptions(search);
          if (field === "author_group" && userGroupOptions.length === 0) return await loadUserGroupOptions();
          if (field === "template") return await loadTemplateOptions(search);
          if (field === "title") return await loadPageOptions(search);
          if (["property", "status", "date_property", "page_property", "smw_property"].includes(field)) {
            if (ontologyProperties.length === 0) await loadOntologyProperties();
            if (!semanticPropertyValuesLoaded) await loadSemanticPropertyValues();
            return ontologyProperties;
          }
        } catch (err) {
          statusText(statusId, err.message, false);
        }
        return [];
      };

      document.getElementById("aiadmin-save-service-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/service-config", { method: "POST", body: JSON.stringify(collectServiceConfig()) });
          serviceConfig = data.values || {};
          await renderServiceConfig();
          statusText("aiadmin-service-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-service-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-test-service-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/service-config/test", { method: "POST" });
          renderServiceTest(data.values || {});
          statusText("aiadmin-service-status", t("aiadmin-message-test-completed"));
        } catch (err) {
          statusText("aiadmin-service-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-external-api").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/external-api/config", { method: "POST", body: JSON.stringify(collectExternalApiConfig()) });
          externalApiConfig = data.values || {};
          await renderExternalApiConfig();
          statusText("aiadmin-external-api-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-external-api-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-test-llm-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/llm/test", { method: "POST" });
          renderLlmTest(data.values || {});
        } catch (err) {
          statusText("aiadmin-settings-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-embedding-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/embedding/config", { method: "POST", body: JSON.stringify(collectEmbeddingConfig()) });
          embeddingConfig = data.values || {};
          await renderEmbeddingConfig();
          statusText("aiadmin-embedding-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-embedding-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-test-embedding-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/embedding/test", { method: "POST" });
          embeddingConfig = data.values || {};
          await renderEmbeddingConfig();
          statusText("aiadmin-embedding-status", t("aiadmin-message-test-completed"));
        } catch (err) {
          statusText("aiadmin-embedding-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-rag-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/rag/config", { method: "POST", body: JSON.stringify(collectRagConfig()) });
          ragConfig = data.values || {};
          await renderRagConfig();
          statusText("aiadmin-rag-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-rag-status", err.message, false);
        }
      });
      document.addEventListener("click", async (event) => {
        if (event.target?.id !== "aiadmin-test-colbert-rag") return;
        try {
          const data = await request("/api/admin/rag/colbert/test", {
            method: "POST",
            body: JSON.stringify(collectRagConfig()),
          });
          const result = data.values || {};
          const status = document.getElementById("aiadmin-colbert-test");
          if (status) {
            status.className = result.status === "ok" ? "ai-admin-status-ok" : "ai-admin-status-error";
            status.textContent = formatText("aiadmin-status-colbert-test", {
              status: result.status || unknown(),
              latency: result.latencyMs ?? unknown(),
              error: result.error || ""
            });
          }
        } catch (err) {
          statusText("aiadmin-rag-status", err.message, false);
        }
      });
      document.addEventListener("click", async (event) => {
        if (event.target?.id !== "aiadmin-reindex-colbert-rag") return;
        try {
          const saved = await request("/api/admin/rag/config", { method: "POST", body: JSON.stringify(collectRagConfig()) });
          ragConfig = saved.values || {};
          await request("/api/admin/reindex", {
            method: "POST",
            body: JSON.stringify({
              dryRun: false,
              llmEnrichmentEnabled: false,
              chunkSize: ragConfig.chunkSize,
              chunkOverlap: ragConfig.chunkOverlap,
              chunkSeparators: ragConfig.chunkSeparators,
            }),
          });
          statusText("aiadmin-rag-status", t("aiadmin-message-reindex-started"));
          await startReindexStatusPolling();
        } catch (err) {
          statusText("aiadmin-rag-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-webhook-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/webhook/config", { method: "POST", body: JSON.stringify(collectWebhookConfig()) });
          webhookConfig = data.values || {};
          await renderWebhookConfig();
          statusText("aiadmin-webhook-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-webhook-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-test-webhook-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/webhook/test", { method: "POST" });
          webhookConfig = data.values || {};
          await renderWebhookConfig();
          statusText("aiadmin-webhook-status", t("aiadmin-message-test-completed"));
        } catch (err) {
          statusText("aiadmin-webhook-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-chat-retention").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/chat-retention/config", { method: "POST", body: JSON.stringify(collectChatRetentionConfig()) });
          chatRetentionConfig = data.values || {};
          await renderChatRetentionConfig();
          statusText("aiadmin-chat-retention-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-chat-retention-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-autofill-config").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/smw/autofill/config", { method: "POST", body: JSON.stringify(collectSemanticAutofillConfig()) });
          semanticAutofillConfig = data.values || {};
          await renderSemanticAutofillConfig();
          statusText("aiadmin-autofill-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-autofill-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-refresh-autofill-status").addEventListener("click", async () => {
        try {
          await renderSemanticAutofillStatus();
          statusText("aiadmin-autofill-status", t("aiadmin-message-refreshed"));
        } catch (err) {
          statusText("aiadmin-autofill-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-trust-model").addEventListener("click", async () => {
        try {
          await request("/api/admin/trust-models", { method: "POST", body: JSON.stringify(collectTrustModel()) });
          await renderTrustModels();
          statusText("aiadmin-trust-model-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-trust-model-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-conflict-detection").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/conflict-detection/config", { method: "POST", body: JSON.stringify(collectConflictDetectionConfig()) });
          conflictDetectionConfig = data.values || {};
          await renderConflictDetectionConfig();
          statusText("aiadmin-conflict-detection-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-conflict-detection-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-test-conflict-detection").addEventListener("click", async () => {
        try {
          statusText("aiadmin-conflict-detection-status", t("aiadmin-message-running"));
          const data = await request("/api/admin/conflict-detection/test", { method: "POST" });
          renderConflictDetectionTest(data.values || {});
          statusText("aiadmin-conflict-detection-status", t("aiadmin-message-test-completed"));
        } catch (err) {
          statusText("aiadmin-conflict-detection-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-trust-entity").addEventListener("click", async () => {
        try {
          const modelId = selectedTrustModelId();
          const data = await request(`/api/admin/trust-models/${encodeURIComponent(modelId)}/entities`, { method: "POST", body: JSON.stringify(collectTrustEntity()) });
          selectedTrustEntityId = data.values?.id || selectedTrustEntityId;
          await renderTrustEntities(modelId, selectedTrustEntityId);
          statusText("aiadmin-trust-entity-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-trust-entity-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-add-trust-entity").addEventListener("click", async () => {
        selectedTrustEntityId = null;
        selectedTrustRuleId = null;
        resetTrustEntityForm();
        resetTrustRuleForm();
        document.getElementById("aiadmin-trust-selected-entity").textContent = "";
        document.getElementById("aiadmin-trust-rules").textContent = t("aiadmin-empty-select-trust-entity");
      });
      document.getElementById("aiadmin-delete-trust-entity").addEventListener("click", async () => {
        try {
          await deleteSelectedTrustEntity();
        } catch (err) {
          statusText("aiadmin-trust-entity-status", err.message, false);
        }
      });
      document.getElementById("trust-entity-type").addEventListener("change", async () => {
        renderTrustEntityValueOptions();
        await loadTrustReferenceOptions(document.getElementById("trust-entity-type").value, "", "aiadmin-trust-entity-status");
      });
      document.getElementById("trust-entity-value").addEventListener("focus", async () => {
        await loadTrustReferenceOptions(document.getElementById("trust-entity-type").value, "", "aiadmin-trust-entity-status");
      });
      document.getElementById("aiadmin-save-trust-rule").addEventListener("click", async () => {
        try {
          await saveTrustPolicyRule();
          statusText("aiadmin-trust-rule-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-trust-rule-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-add-trust-rule").addEventListener("click", async () => {
        selectedTrustPolicyRowId = null;
        selectedTrustEntityId = null;
        selectedTrustRuleId = null;
        resetTrustRuleForm();
      });
      document.getElementById("aiadmin-delete-trust-rule").addEventListener("click", async () => {
        try {
          await deleteSelectedTrustRule();
        } catch (err) {
          statusText("aiadmin-trust-rule-status", err.message, false);
        }
      });
      document.getElementById("trust-rule-field").addEventListener("change", () => {
        updateTrustRuleConditionControls();
        loadTrustReferenceOptions(document.getElementById("trust-rule-field").value);
      });
      document.getElementById("trust-rule-operator").addEventListener("change", updateTrustRuleConditionControls);
      document.getElementById("trust-rule-value-select").addEventListener("change", (event) => {
        document.getElementById("trust-rule-value").value = event.target.value;
      });
      document.getElementById("trust-rule-value").addEventListener("input", (event) => {
        const field = document.getElementById("trust-rule-field").value;
        if (field === "category") {
          scheduleCategoryOptionsLoad(event.target.value, "aiadmin-trust-rule-status");
          return;
        }
        if (field === "tag") {
          scheduleWikiReferenceLoad("trust-rule-tag", event.target.value, loadTagOptions, "aiadmin-trust-rule-status");
          return;
        }
        if (field === "template") {
          scheduleWikiReferenceLoad("trust-rule-template", event.target.value, loadTemplateOptions, "aiadmin-trust-rule-status");
          return;
        }
        if (field === "title") {
          scheduleWikiReferenceLoad("trust-rule-title", event.target.value, loadPageOptions, "aiadmin-trust-rule-status");
        }
      });
      document.getElementById("trust-rule-property").addEventListener("focus", () => {
        loadTrustReferenceOptions(document.getElementById("trust-rule-field").value).catch((err) => {
          statusText("aiadmin-trust-rule-status", err.message, false);
        });
      });
      document.getElementById("trust-rule-property").addEventListener("input", () => {
        renderTrustRuleValueOptions();
        loadTrustReferenceOptions(document.getElementById("trust-rule-field").value).catch((err) => {
          statusText("aiadmin-trust-rule-status", err.message, false);
        });
      });
      document.getElementById("aiadmin-add-trust-rule-flag").addEventListener("click", addTrustRuleFlag);
      document.getElementById("trust-rule-new-flag").addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        addTrustRuleFlag();
      });
      document.getElementById("aiadmin-run-trust-preview").addEventListener("click", async () => {
        try {
          await renderTrustPreview();
          statusText("aiadmin-trust-preview-status", t("aiadmin-message-preview-complete"));
        } catch (err) {
          statusText("aiadmin-trust-preview-status", err.message, false);
        }
      });
      document.getElementById("trust-preview-title").addEventListener("input", (event) => {
        scheduleWikiReferenceLoad("trust-preview-title", event.target.value, loadPageOptions, "aiadmin-trust-preview-status");
      });
      [
        ["categories", (value) => scheduleCategoryOptionsLoad(value, "aiadmin-trust-preview-status")],
        ["tags", (value) => scheduleWikiReferenceLoad("trust-preview-tags", value, loadTagOptions, "aiadmin-trust-preview-status")],
        ["templates", (value) => scheduleWikiReferenceLoad("trust-preview-templates", value, loadTemplateOptions, "aiadmin-trust-preview-status")],
      ].forEach(([key, schedule]) => {
        const config = trustPreviewListConfigs[key];
        document.getElementById(config.searchId).addEventListener("input", (event) => schedule(event.target.value));
      });
      Object.keys(trustPreviewListConfigs).forEach((key) => {
        const config = trustPreviewListConfigs[key];
        document.getElementById(`${config.inputId}-add`)?.addEventListener("click", () => addTrustPreviewListValue(key));
        document.getElementById(config.searchId).addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          addTrustPreviewListValue(key);
        });
      });
      document.getElementById("aiadmin-run-trust-recalc").addEventListener("click", async () => {
        try {
          await renderTrustRecalculation();
          statusText("aiadmin-trust-recalc-status", t("aiadmin-message-recalculation-complete"));
        } catch (err) {
          statusText("aiadmin-trust-recalc-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-trust-schedule").addEventListener("click", async () => {
        try {
          await request("/api/admin/trust-recalculation/config", { method: "POST", body: JSON.stringify(collectTrustSchedule()) });
          await renderTrustSchedule();
          statusText("aiadmin-trust-schedule-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-trust-schedule-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-refresh-audit").addEventListener("click", () => {
        renderAuditLog();
      });
      document.getElementById("aiadmin-save-indexing-profile").addEventListener("click", async () => {
        try {
          await request("/api/admin/indexing-profiles", { method: "POST", body: JSON.stringify(collectIndexingProfile()) });
          await renderIndexingProfiles();
          await renderIndexingSchedulerStatus();
          statusText("aiadmin-indexing-profile-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-indexing-profile-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-reindex-profile").addEventListener("change", () => {
        const selected = indexingProfiles.find((profile) => profile.id === document.getElementById("aiadmin-reindex-profile").value);
        if (!selected) return;
        document.getElementById("aiadmin-reindex-attachments").checked = Boolean(selected.attachmentsEnabled);
        document.getElementById("aiadmin-reindex-dryrun").checked = Boolean(selected.dryRunDefault);
        document.getElementById("aiadmin-reindex-maxpages").value = selected.maxPagesDefault ?? "";
      });
      document.getElementById("aiadmin-save-settings").addEventListener("click", async () => {
        try {
          await request("/api/admin/llm/config", { method: "POST", body: JSON.stringify(collectSettings()) });
          statusText("aiadmin-settings-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-settings-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-reset-settings").addEventListener("click", async () => {
        try {
          await request("/api/admin/config/reset", { method: "POST" });
          await renderSettings();
          statusText("aiadmin-settings-status", t("aiadmin-message-reset"));
        } catch (err) {
          statusText("aiadmin-settings-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-add-mime").addEventListener("click", () => {
        const mime = document.getElementById("aiadmin-new-mime").value.trim();
        if (!mime) return;
        documentPolicy.mimeTypes[mime] = { mode: document.getElementById("aiadmin-new-mode").value };
        document.getElementById("aiadmin-new-mime").value = "";
        renderDocumentPolicy();
      });
      document.getElementById("aiadmin-save-policy").addEventListener("click", async () => {
        try {
          await request("/api/admin/document-processing", { method: "POST", body: JSON.stringify(collectDocumentPolicy()) });
          await loadDocumentPolicy();
          statusText("aiadmin-policy-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-policy-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-reset-policy").addEventListener("click", async () => {
        try {
          await request("/api/admin/document-processing/reset", { method: "POST" });
          await loadDocumentPolicy();
          statusText("aiadmin-policy-status", t("aiadmin-message-reset"));
        } catch (err) {
          statusText("aiadmin-policy-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-semantic-refresh").addEventListener("click", () => {
        renderSemanticStatus();
      });
      document.getElementById("aiadmin-semantic-search-btn").addEventListener("click", () => {
        renderSemanticSearch();
      });
      document.getElementById("aiadmin-save-ontology").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/smw/ontology", { method: "POST", body: JSON.stringify(collectOntologyProperty()) });
          renderOntologyResult(data.values || {});
          selectedOntologyPropertyId = data.values?.id || selectedOntologyPropertyId;
          await renderOntologyProperties();
          await renderIndexingProfiles();
          statusText("aiadmin-ontology-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-ontology-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-add-ontology").addEventListener("click", () => {
        resetOntologyForm();
        document.getElementById("aiadmin-ontology-result").innerHTML = "";
      });
      document.getElementById("ontology-name").addEventListener("change", (event) => {
        fillOntologyFormByName(event.target.value);
      });
      document.getElementById("aiadmin-generate-ontology-vector").addEventListener("click", async () => {
        try {
          await generateSelectedOntologyVector();
        } catch (err) {
          statusText("aiadmin-ontology-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-similar-ontology").addEventListener("click", async () => {
        try {
          await renderSelectedOntologySimilarities();
        } catch (err) {
          statusText("aiadmin-ontology-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-delete-ontology").addEventListener("click", async () => {
        try {
          await deleteSelectedOntologyProperty();
        } catch (err) {
          statusText("aiadmin-ontology-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-search-smw-properties").addEventListener("click", async () => {
        try {
          statusText("aiadmin-ontology-status", t("aiadmin-message-searching"));
          await loadSmwPropertyCatalog({
            force: true,
            search: document.getElementById("ontology-smw-search").value,
          });
          statusText("aiadmin-ontology-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-ontology-status", err.message, false);
        }
      });
      document.getElementById("ontology-smw-search").addEventListener("keydown", async (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        document.getElementById("aiadmin-search-smw-properties").click();
      });
      document.getElementById("aiadmin-load-more-smw-properties").addEventListener("click", async () => {
        try {
          await loadSmwPropertyCatalog({ append: true });
        } catch (err) {
          statusText("aiadmin-ontology-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-refresh-sensitive-properties").addEventListener("click", async () => {
        try {
          await renderSensitiveProperties();
          statusText("aiadmin-sensitive-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-sensitive-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-save-sensitive-properties").addEventListener("click", async () => {
        try {
          await saveSensitiveProperties();
          statusText("aiadmin-sensitive-status", t("aiadmin-message-saved"));
        } catch (err) {
          statusText("aiadmin-sensitive-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-clusterize-ontology").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/smw/ontology/clusterize", { method: "POST", body: JSON.stringify({ threshold: 0.82 }) });
          renderOntologyResult(data.values || {});
          statusText("aiadmin-ontology-status", t("aiadmin-message-clusterization-ready"));
        } catch (err) {
          statusText("aiadmin-ontology-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-classify-ontology-fragment").addEventListener("click", async () => {
        try {
          const data = await request("/api/admin/smw/ontology/classify-fragment", {
            method: "POST",
            body: JSON.stringify(collectOntologyFragment()),
          });
          renderOntologyResult(data.values || {});
          statusText("aiadmin-ontology-status", t("aiadmin-message-classification-ready"));
        } catch (err) {
          statusText("aiadmin-ontology-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-start-reindex").addEventListener("click", async () => {
        try {
          await startReindex();
          statusText("aiadmin-management-status", t("aiadmin-message-reindex-started"));
        } catch (err) {
          statusText("aiadmin-management-status", err.message, false);
        }
      });
      document.getElementById("aiadmin-clear-cache").addEventListener("click", async () => {
        try {
          await request("/api/admin/cache/clear", { method: "POST" });
          statusText("aiadmin-management-status", t("aiadmin-message-cache-cleared"));
        } catch (err) {
          statusText("aiadmin-management-status", err.message, false);
        }
      });
      ["include", "exclude"].forEach((kind) => {
        document.getElementById(`idx-profile-category-${kind}-add`).addEventListener("click", () => addCategoryFilterValue(kind));
        document.getElementById(`idx-profile-category-${kind}-select`).addEventListener("change", (event) => {
          document.getElementById(`idx-profile-category-${kind}-search`).value = event.target.value;
        });
        document.getElementById(`idx-profile-category-${kind}-select`).addEventListener("dblclick", () => addCategoryFilterValue(kind));
        document.getElementById(`idx-profile-category-${kind}-search`).addEventListener("input", (event) => {
          scheduleCategoryOptionsLoad(event.target.value);
        });
        document.getElementById(`idx-profile-category-${kind}-search`).addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          addCategoryFilterValue(kind);
        });
      });

      initializeTabs();
      applyStaticTranslations();
      updateTrustRuleConditionControls();
      renderTrustEntityValueOptions();
      renderTrustRuleFlagOptions();
      renderTrustRuleFlagChips();
      renderTrustPreviewLists();
      loadCategoryOptions().catch((err) => statusText("aiadmin-indexing-profile-status", err.message, false));
      loadNamespaceOptions().catch((err) => statusText("aiadmin-trust-model-status", err.message, false));
      loadUserGroupOptions().catch((err) => statusText("aiadmin-trust-model-status", err.message, false));
      loadTagOptions().catch((err) => statusText("aiadmin-trust-model-status", err.message, false));
      loadTemplateOptions().catch((err) => statusText("aiadmin-trust-model-status", err.message, false));
      loadPageOptions("CorpIT").catch((err) => statusText("aiadmin-trust-model-status", err.message, false));
      renderHealth();
      renderServiceConfig().catch((err) => statusText("aiadmin-service-status", err.message, false));
      renderExternalApiConfig().catch((err) => statusText("aiadmin-external-api-status", err.message, false));
      renderSettings().catch((err) => statusText("aiadmin-settings-status", err.message, false));
      renderEmbeddingConfig().catch((err) => statusText("aiadmin-embedding-status", err.message, false));
      renderRagConfig().catch((err) => statusText("aiadmin-rag-status", err.message, false));
      renderWebhookConfig().catch((err) => statusText("aiadmin-webhook-status", err.message, false));
      renderChatRetentionConfig().catch((err) => statusText("aiadmin-chat-retention-status", err.message, false));
      renderSemanticAutofillConfig().catch((err) => statusText("aiadmin-autofill-status", err.message, false));
      renderTrustModels().catch((err) => statusText("aiadmin-trust-model-status", err.message, false));
      renderConflictDetectionConfig().catch((err) => statusText("aiadmin-conflict-detection-status", err.message, false));
      renderTrustSchedule().catch((err) => statusText("aiadmin-trust-schedule-status", err.message, false));
      loadDocumentPolicy().catch((err) => statusText("aiadmin-policy-status", err.message, false));
      renderOntologyProperties().catch((err) => statusText("aiadmin-ontology-status", err.message, false));
      renderSensitiveProperties().catch((err) => statusText("aiadmin-sensitive-status", err.message, false));
      renderSemanticStatus();
      renderIndexingProfiles().catch((err) => statusText("aiadmin-indexing-profile-status", err.message, false));
      renderIndexingSchedulerStatus().catch((err) => statusText("aiadmin-indexing-profile-status", err.message, false));
      startReindexStatusPolling();
      renderAuditLog();
    })();
    </script>';
  }

  protected function getGroupName(): string
  {
    return 'other';
  }
}
