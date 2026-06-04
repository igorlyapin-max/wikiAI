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

    $this->getOutput()->addJsConfigVars(
      'wgAIAssistantAdminConfig',
      $this->getAdminClientConfig($apiBase, $mediaWikiSyncerUrl, $adminProxyEnabled)
    );
    $this->getOutput()->addModules('ext.aiadmin');
    $this->getOutput()->addHTML($this->getAdminStyles());
    $this->getOutput()->addHTML($this->renderShell());
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
      'aiadmin-action-build-colbert-index',
      'aiadmin-action-cancel',
      'aiadmin-action-delete',
      'aiadmin-action-edit',
      'aiadmin-action-export-json',
      'aiadmin-action-generate-vector',
      'aiadmin-action-load-more',
      'aiadmin-action-preview',
      'aiadmin-action-promote',
      'aiadmin-action-recalculate-trust-payload',
      'aiadmin-action-reindex-colbert',
      'aiadmin-action-refresh',
      'aiadmin-action-refresh-status',
      'aiadmin-action-open',
      'aiadmin-action-opensearch-analyze',
      'aiadmin-action-remove',
      'aiadmin-action-reset',
      'aiadmin-action-duplicate-current-rag',
      'aiadmin-action-restore-retrieval-profiles',
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
      'aiadmin-doc-capabilities-title',
      'aiadmin-doc-capabilities-note',
      'aiadmin-doc-cap-archive-title',
      'aiadmin-doc-cap-archive-description',
      'aiadmin-doc-cap-base-title',
      'aiadmin-doc-cap-base-description',
      'aiadmin-doc-cap-media-title',
      'aiadmin-doc-cap-media-description',
      'aiadmin-doc-cap-office-title',
      'aiadmin-doc-cap-office-description',
      'aiadmin-doc-cap-mode-disabled',
      'aiadmin-doc-cap-mode-metadata',
      'aiadmin-doc-cap-mode-missing',
      'aiadmin-doc-cap-mode-ocr',
      'aiadmin-doc-cap-mode-text',
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
      'aiadmin-field-default-retrieval-profile',
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
      'aiadmin-field-index-targets',
      'aiadmin-field-indexed',
      'aiadmin-field-interval-min',
      'aiadmin-field-lexical-backend',
      'aiadmin-field-lexical-gate-mode',
      'aiadmin-field-lexical-candidate-limit',
      'aiadmin-field-lexical-edit-distance-enabled',
      'aiadmin-field-lexical-min-matched-terms',
      'aiadmin-field-lexical-normalization-mode',
      'aiadmin-field-lexical-synonyms',
      'aiadmin-field-lexical-synonyms-enabled',
      'aiadmin-field-lexical-transliteration-enabled',
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
      'aiadmin-field-opensearch-analyzer',
      'aiadmin-field-opensearch-auth-configured',
      'aiadmin-field-opensearch-base-url',
      'aiadmin-field-opensearch-candidate-limit',
      'aiadmin-field-opensearch-enabled',
      'aiadmin-field-opensearch-fuzzy',
      'aiadmin-field-opensearch-highlight',
      'aiadmin-field-opensearch-index',
      'aiadmin-field-opensearch-preview-query',
      'aiadmin-field-opensearch-text-boost',
      'aiadmin-field-opensearch-title-boost',
      'aiadmin-field-opensearch-tls',
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
      'aiadmin-field-retrieval-api-enabled',
      'aiadmin-field-retrieval-mcp-enabled',
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
      'aiadmin-field-search-history-enabled',
      'aiadmin-field-search-history-limit',
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
      'aiadmin-field-trigram-candidate-limit',
      'aiadmin-field-trigram-index-enabled',
      'aiadmin-field-trigram-min-query-length',
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
      'aiadmin-help-opensearch-base-url',
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
      'aiadmin-message-duplicated-from-current-rag',
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
      'aiadmin-status-search-readiness',
      'aiadmin-status-retrieval-profile-readiness',
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
      'aiadmin-section-lexical-experimental',
      'aiadmin-section-retrieval-profiles',
      'aiadmin-section-model-assignments',
      'aiadmin-section-opensearch',
      'aiadmin-section-assistant-ui',
      'aiadmin-section-trust-entities',
      'aiadmin-section-trust-preview',
      'aiadmin-section-trust-recalc',
      'aiadmin-section-trust-rules',
      'aiadmin-trust-source-legacy-entity',
      'aiadmin-trust-source-legacy-rule',
      'aiadmin-trust-source-rule',
      'aiadmin-tab-audit',
      'aiadmin-tab-autofill',
      'aiadmin-tab-bm25',
      'aiadmin-tab-chat-retention',
      'aiadmin-tab-colbert',
      'aiadmin-tab-composition',
      'aiadmin-tab-documents',
      'aiadmin-tab-embeddings',
      'aiadmin-tab-external-api',
      'aiadmin-tab-indexing',
      'aiadmin-tab-llm',
      'aiadmin-tab-ontology',
      'aiadmin-tab-overview',
      'aiadmin-tab-opensearch',
      'aiadmin-tab-rag',
      'aiadmin-tab-retrieval-profiles',
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
      'aiadmin-table-api-mcp',
      'aiadmin-table-readiness',
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
      'aiadmin-value-legacy-global-rag',
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
      .ai-admin-status-warning { color: #D97706; font-weight: bold; }
      .ai-admin-status-error { color: #d33; font-weight: bold; }
      .ai-admin-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
      .ai-admin-summary-item { background: #f8f9fa; border: 1px solid #eaecf0; border-radius: 2px; padding: 8px 10px; min-width: 120px; }
      .ai-admin-summary-item strong { display: block; font-size: 1.1em; }
      .ai-admin-document-capabilities { margin: 12px 0 14px; }
      .ai-admin-document-capabilities h3 { margin: 0 0 6px; font-size: 1.05em; }
      .ai-admin-document-capability-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px; margin-top: 8px;
      }
      .ai-admin-document-capability {
        border: 1px solid #eaecf0; border-radius: 2px; background: #f8f9fa; padding: 10px;
      }
      .ai-admin-document-capability h4 { margin: 0 0 6px; font-size: 1em; }
      .ai-admin-document-capability p { margin: 6px 0 0; }
      .ai-admin-document-capability-modes { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
      .ai-admin-mode-badge {
        display: inline-flex; align-items: center; min-height: 22px; padding: 2px 6px;
        border: 1px solid #a2a9b1; border-radius: 2px; background: #fff; font-size: 12px; font-weight: bold;
      }
      .ai-admin-mode-text { border-color: #059669; color: #065f46; background: #ecfdf5; }
      .ai-admin-mode-ocr { border-color: #7C3AED; color: #4c1d95; background: #f5f3ff; }
      .ai-admin-mode-metadata { border-color: #D97706; color: #92400e; background: #fffbeb; }
      .ai-admin-mode-disabled, .ai-admin-mode-missing { border-color: #DC2626; color: #991b1b; background: #fef2f2; }
      .ai-admin-document-extension-list { color: #111827; font-size: 12px; overflow-wrap: anywhere; }
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
        <button type="button" class="ai-admin-tab" data-ai-tab="retrieval-profiles">' . $this->msgHtml('aiadmin-tab-retrieval-profiles') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="llm">' . $this->msgHtml('aiadmin-tab-llm') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="embeddings">' . $this->msgHtml('aiadmin-tab-embeddings') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="rag">' . $this->msgHtml('aiadmin-tab-rag') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="bm25">' . $this->msgHtml('aiadmin-tab-bm25') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="opensearch">' . $this->msgHtml('aiadmin-tab-opensearch') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="colbert">' . $this->msgHtml('aiadmin-tab-colbert') . '</button>
        <button type="button" class="ai-admin-tab" data-ai-tab="composition">' . $this->msgHtml('aiadmin-tab-composition') . '</button>
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
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="retrieval-profiles">
        <h2>' . $this->msgHtml('aiadmin-section-retrieval-profiles') . '</h2>
        <div id="aiadmin-retrieval-profiles" class="ai-admin-search-results">' . $this->msgHtml('aiadmin-loading') . '</div>
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
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="bm25">
        <h2>' . $this->msgHtml('aiadmin-tab-bm25') . '</h2>
        <form id="aiadmin-bm25-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-bm25-config">' . $this->msgHtml('aiadmin-save') . '</button>
        <span id="aiadmin-bm25-status"></span>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="opensearch">
        <h2>' . $this->msgHtml('aiadmin-section-opensearch') . '</h2>
        <form id="aiadmin-opensearch-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-opensearch-config">' . $this->msgHtml('aiadmin-save') . '</button>
        <span id="aiadmin-opensearch-status"></span>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="colbert">
        <h2>' . $this->msgHtml('aiadmin-tab-colbert') . '</h2>
        <form id="aiadmin-colbert-config"></form>
        <div id="aiadmin-colbert-indexes">' . $this->msgHtml('aiadmin-loading') . '</div>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-colbert-config">' . $this->msgHtml('aiadmin-save') . '</button>
        <span id="aiadmin-colbert-status"></span>
      </div>
      <div class="ai-admin-card ai-admin-panel" data-ai-panel="composition">
        <h2>' . $this->msgHtml('aiadmin-tab-composition') . '</h2>
        <form id="aiadmin-composition-config"></form>
        <button type="button" class="ai-admin-btn ai-admin-btn-primary" id="aiadmin-save-composition-config">' . $this->msgHtml('aiadmin-save') . '</button>
        <span id="aiadmin-composition-status"></span>
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
          <div class="ai-admin-row">
            <span>' . $this->msgHtml('aiadmin-field-index-targets') . '</span>
            <label><input type="checkbox" class="idx-profile-target" value="dense" checked /> dense</label>
            <label><input type="checkbox" class="idx-profile-target" value="bm25" checked /> BM25</label>
            <label><input type="checkbox" class="idx-profile-target" value="colbert" /> ColBERT</label>
            <label><input type="checkbox" class="idx-profile-target" value="opensearch" /> OpenSearch</label>
            <label><input type="checkbox" class="idx-profile-target" value="attachments" /> attachments</label>
            <label><input type="checkbox" class="idx-profile-target" value="semanticFacts" checked /> semanticFacts</label>
            <label><input type="checkbox" class="idx-profile-target" value="ontologyVectors" /> ontologyVectors</label>
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

  private function getAdminClientConfig(string $apiBase, string $mediaWikiSyncerUrl, bool $adminProxyEnabled): array
  {
    return [
      'apiBase' => $apiBase,
      'mediaWikiSyncerUrl' => $mediaWikiSyncerUrl,
      'adminProxyEnabled' => $adminProxyEnabled,
      'i18n' => $this->getAdminI18nMessages(),
    ];
  }

  protected function getGroupName(): string
  {
    return 'other';
  }
}
