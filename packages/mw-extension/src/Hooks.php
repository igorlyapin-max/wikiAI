<?php
namespace MediaWiki\Extension\AIAssistant;

use MediaWiki\Page\Hook\PageDeleteCompleteHook;
use MediaWiki\Page\Hook\ArticleProtectCompleteHook;
use MediaWiki\Storage\Hook\PageSaveCompleteHook;
use MediaWiki\Hook\PageMoveCompleteHook;
use MediaWiki\Permissions\Hook\GetUserPermissionsErrorsHook;
use MediaWiki\Revision\RevisionRecord;
use MediaWiki\Storage\EditResult;
use MediaWiki\User\UserIdentity;
use MediaWiki\Page\ProperPageIdentity;
use MediaWiki\Permissions\Authority;
use MediaWiki\Logging\ManualLogEntry;
use MediaWiki\MediaWikiServices;

class Hooks implements
  PageSaveCompleteHook,
  PageDeleteCompleteHook,
  PageMoveCompleteHook,
  ArticleProtectCompleteHook,
  GetUserPermissionsErrorsHook
{
  private const WEBHOOK_JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

  private static function getHttpFactory()
  {
    return MediaWikiServices::getInstance()->getHttpRequestFactory();
  }

  private static function sendWebhook(string $event, array $data): void
  {
    $config = MediaWikiServices::getInstance()->getMainConfig();
    $syncerUrl = $config->get('AIAssistantSyncerUrl');
    $url = rtrim($syncerUrl, '/') . '/webhook/page';
    $payload = self::withoutNullValues(array_merge(['event' => $event], $data));
    $payloadJson = json_encode($payload, self::WEBHOOK_JSON_FLAGS);
    if ($payloadJson === false) {
      wfDebugLog('aiassistant', 'Webhook payload JSON encoding failed for event: ' . $event);
      return;
    }
    $headers = [
      'Content-Type' => 'application/json',
    ];
    $secret = trim((string)$config->get('AIAssistantWebhookSecret'));
    if ($secret !== '') {
      $signatureTimestamp = (string)time();
      $headers['X-WikiAI-Webhook-Timestamp'] = $signatureTimestamp;
      $headers['X-WikiAI-Webhook-Signature'] = self::signWebhookPayload(
        $secret,
        $signatureTimestamp,
        $payload
      );
      $headers['X-WikiAI-Webhook-Idempotency-Key'] = self::webhookIdempotencyKey($payload);
    }

    try {
      $httpRequest = self::getHttpFactory()->create(
        $url,
        [
          'postData' => $payloadJson,
          'method' => 'POST',
          'timeout' => 3,
          'followRedirects' => false,
        ],
        __METHOD__
      );
      foreach ($headers as $name => $value) {
        $httpRequest->setHeader($name, $value);
      }

      $status = $httpRequest->execute();
      if (!$status->isOK()) {
        wfDebugLog(
          'aiassistant',
          'Webhook failed with HTTP ' . $httpRequest->getStatus() . ' for event: ' . $event
        );
      }
    } catch (\Throwable $e) {
      wfDebugLog('aiassistant', 'Webhook failed: ' . $e->getMessage());
    }
  }

  private static function withoutNullValues(array $input): array
  {
    return array_filter($input, static function ($value) {
      return $value !== null;
    });
  }

  private static function isListArray(array $value): bool
  {
    if ($value === []) {
      return true;
    }
    return array_keys($value) === range(0, count($value) - 1);
  }

  private static function canonicalizeWebhookValue($value)
  {
    if (!is_array($value)) {
      return $value;
    }
    if (self::isListArray($value)) {
      return array_map([self::class, 'canonicalizeWebhookValue'], $value);
    }

    ksort($value, SORT_STRING);
    foreach ($value as $key => $entryValue) {
      $value[$key] = self::canonicalizeWebhookValue($entryValue);
    }
    return $value;
  }

  private static function canonicalWebhookJson(array $payload): string
  {
    return json_encode(self::canonicalizeWebhookValue($payload), self::WEBHOOK_JSON_FLAGS);
  }

  private static function signWebhookPayload(string $secret, string $timestamp, array $payload): string
  {
    return 'sha256=' . hash_hmac('sha256', $timestamp . '.' . self::canonicalWebhookJson($payload), $secret);
  }

  private static function webhookIdempotencyKey(array $payload): string
  {
    $revisionOrTimestamp = isset($payload['rev_id']) ? (string)$payload['rev_id'] : (string)($payload['timestamp'] ?? '');
    return implode(':', [
      (string)($payload['event'] ?? 'unknown'),
      (string)($payload['page_id'] ?? '0'),
      $revisionOrTimestamp,
    ]);
  }

  /**
   * Test-stand page-level read ACL. Production deployments should prefer
   * their enterprise MediaWiki ACL extension or namespace-level restrictions.
   */
  public function onGetUserPermissionsErrors($title, $user, $action, &$result)
  {
    if ($action !== 'read') {
      return true;
    }

    $config = MediaWikiServices::getInstance()->getMainConfig();
    $rules = $config->get('AIAssistantPageAclRules');
    if (!is_array($rules) || count($rules) === 0) {
      return true;
    }

    $prefixedTitle = str_replace('_', ' ', $title->getPrefixedText());
    $matchedGroups = self::matchPageAclGroups($prefixedTitle, $rules);
    if ($matchedGroups === null || in_array('*', $matchedGroups, true)) {
      return true;
    }

    if (count($matchedGroups) === 0) {
      $result = ['aiassistant-pageacl-denied'];
      return false;
    }

    $userGroups = MediaWikiServices::getInstance()
      ->getUserGroupManager()
      ->getUserEffectiveGroups($user);

    if (count(array_intersect($matchedGroups, $userGroups)) > 0) {
      return true;
    }

    $result = ['aiassistant-pageacl-denied'];
    return false;
  }

  private static function matchPageAclGroups(string $prefixedTitle, array $rules): ?array
  {
    foreach ($rules as $rule) {
      if (!is_array($rule)) {
        continue;
      }

      $groups = self::normalizeAclGroups($rule['groups'] ?? []);
      $exactTitle = isset($rule['title']) ? str_replace('_', ' ', (string)$rule['title']) : null;
      if ($exactTitle !== null && $exactTitle === $prefixedTitle) {
        return $groups;
      }

      $prefix = isset($rule['prefix']) ? str_replace('_', ' ', (string)$rule['prefix']) : null;
      if ($prefix !== null && $prefix !== '' && strpos($prefixedTitle, $prefix) === 0) {
        return $groups;
      }
    }

    return null;
  }

  private static function normalizeAclGroups($groups): array
  {
    if (is_string($groups)) {
      $groups = array_filter(array_map('trim', explode('|', $groups)));
    }
    if (!is_array($groups)) {
      return [];
    }

    $normalized = [];
    foreach ($groups as $group) {
      if (!is_string($group)) {
        continue;
      }
      $trimmed = trim($group);
      if ($trimmed !== '') {
        $normalized[] = $trimmed;
      }
    }

    return array_values(array_unique($normalized));
  }

  public function onPageSaveComplete(
    $wikiPage,
    $user,
    $summary,
    $flags,
    $revisionRecord,
    $editResult
  ): void {
    $title = $wikiPage->getTitle()->getPrefixedText();
    $namespace = $wikiPage->getTitle()->getNamespace();
    $pageId = $wikiPage->getId();
    $revId = $revisionRecord->getId();
    $timestamp = wfTimestamp(TS_ISO_8601, $revisionRecord->getTimestamp());

    self::sendWebhook('edit', [
      'page_id' => $pageId,
      'title' => $title,
      'namespace' => $namespace,
      'rev_id' => $revId,
      'timestamp' => $timestamp,
      'user' => $user->getName(),
      'user_id' => $user->getId(),
      'summary' => $summary,
    ]);
  }

  public function onPageDeleteComplete(
    \MediaWiki\Page\ProperPageIdentity $page,
    \MediaWiki\Permissions\Authority $deleter,
    string $reason,
    int $pageID,
    \MediaWiki\Revision\RevisionRecord $deletedRev,
    \MediaWiki\Logging\ManualLogEntry $logEntry,
    int $archivedRevisionCount
  ): void {
    self::sendWebhook('delete', [
      'page_id' => $pageID,
      'title' => \Title::castFromPageIdentity($page)->getPrefixedText(),
      'namespace' => $page->getNamespace(),
      'timestamp' => wfTimestamp(TS_ISO_8601),
      'user' => $deleter->getUser()->getName(),
      'user_id' => $deleter->getUser()->getId(),
      'summary' => $reason,
    ]);
  }

  public function onPageMoveComplete(
    $old,
    $new,
    $user,
    $pageid,
    $redirid,
    $reason,
    $revision
  ): void {
    self::sendWebhook('move', [
      'page_id' => $pageid,
      'title' => $new->getPrefixedText(),
      'old_title' => $old->getPrefixedText(),
      'new_title' => $new->getPrefixedText(),
      'namespace' => $new->getNamespace(),
      'rev_id' => $revision ? $revision->getId() : null,
      'timestamp' => wfTimestamp(TS_ISO_8601),
      'user' => $user->getName(),
      'user_id' => $user->getId(),
      'summary' => $reason,
    ]);
  }

  public function onArticleProtectComplete(
    $wikiPage,
    $user,
    $protect,
    $reason
  ): void {
    self::sendWebhook('protect', [
      'page_id' => $wikiPage->getId(),
      'title' => $wikiPage->getTitle()->getPrefixedText(),
      'namespace' => $wikiPage->getTitle()->getNamespace(),
      'timestamp' => wfTimestamp(TS_ISO_8601),
      'user' => $user->getName(),
      'user_id' => $user->getId(),
      'summary' => $reason,
    ]);
  }
}
