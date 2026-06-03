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
  private static function getHttpFactory()
  {
    return MediaWikiServices::getInstance()->getHttpRequestFactory();
  }

  private static function sendWebhook(string $event, array $data): void
  {
    $config = MediaWikiServices::getInstance()->getMainConfig();
    $syncerUrl = $config->get('AIAssistantSyncerUrl');
    $url = rtrim($syncerUrl, '/') . '/webhook/page';
    try {
      $response = self::getHttpFactory()->post(
        $url,
        [
          'postData' => json_encode(array_merge(['event' => $event], $data)),
          'headers' => ['Content-Type: application/json'],
          'timeout' => 3,
        ],
        __METHOD__
      );
      if ($response === false) {
        wfDebugLog('aiassistant', 'Webhook returned false for event: ' . $event);
      }
    } catch (\Exception $e) {
      wfDebugLog('aiassistant', 'Webhook failed: ' . $e->getMessage());
    }
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
