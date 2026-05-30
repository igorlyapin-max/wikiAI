<?php
namespace MediaWiki\Extension\AIAssistant;

use MediaWiki\Http\Http;
use MediaWiki\Page\Hook\PageDeleteCompleteHook;
use MediaWiki\Page\Hook\ArticleProtectCompleteHook;
use MediaWiki\Storage\Hook\PageSaveCompleteHook;
use MediaWiki\Hook\PageMoveCompleteHook;
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
  ArticleProtectCompleteHook
{
  private static function sendWebhook(string $event, array $data): void
  {
    $config = MediaWikiServices::getInstance()->getMainConfig();
    $syncerUrl = $config->get('AIAssistantSyncerUrl');
    $url = rtrim($syncerUrl, '/') . '/webhook/page';

    try {
      Http::post($url, [
        'postData' => json_encode(array_merge(['event' => $event], $data)),
        'headers' => ['Content-Type: application/json'],
        'timeout' => 3,
      ]);
    } catch (\Exception $e) {
      wfDebugLog('aiassistant', 'Webhook failed: ' . $e->getMessage());
    }
  }

  public function onPageSaveComplete(
    $wikiPage,
    $user,
    $summary,
    $flags,
    $revisionRecord,
    $editResult
  ): void {
    $title = $wikiPage->getTitle();
    self::sendWebhook('edit', [
      'page_id' => $wikiPage->getId(),
      'title' => $title->getPrefixedText(),
      'namespace' => $title->getNamespace(),
      'rev_id' => $revisionRecord ? $revisionRecord->getId() : 0,
      'timestamp' => wfTimestampNow(),
    ]);
  }

  public function onPageDeleteComplete(
    ProperPageIdentity $page,
    Authority $deleter,
    string $reason,
    int $pageID,
    RevisionRecord $deletedRev,
    ManualLogEntry $logEntry,
    int $archivedRevisionCount
  ): void {
    self::sendWebhook('delete', [
      'page_id' => $pageID,
      'title' => \Title::castFromPageIdentity($page)->getPrefixedText(),
      'namespace' => $page->getNamespace(),
      'timestamp' => wfTimestampNow(),
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
      'namespace' => $new->getNamespace(),
      'timestamp' => wfTimestampNow(),
    ]);
  }

  public function onArticleProtectComplete($article, $user, $protections, $reason): void
  {
    $title = $article->getTitle();
    self::sendWebhook('protect', [
      'page_id' => $article->getId(),
      'title' => $title->getPrefixedText(),
      'namespace' => $title->getNamespace(),
      'protections' => $protections,
      'timestamp' => wfTimestampNow(),
    ]);
  }
}
