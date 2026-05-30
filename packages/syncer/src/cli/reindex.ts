import { fetchAllPages, fetchPageContent, fetchPageFiles, fetchFileInfo, downloadFile } from '../services/mediawiki.js';
import { splitText } from '../services/chunker.js';
import { upsertChunks, upsertAttachmentChunks } from '../services/qdrant.js';
import { getAllowedGroups } from '../services/acl.js';
import { processAttachment } from '../services/attachment.js';
import { config } from '../config.js';

const ENABLE_ATTACHMENTS = process.env.ENABLE_ATTACHMENTS !== 'false';

async function reindexAll(): Promise<void> {
  console.log('=== Full Wiki Reindex ===');
  console.log(`Chunk size: ${config.chunkSize}, overlap: ${config.chunkOverlap}`);
  console.log(`Attachments: ${ENABLE_ATTACHMENTS ? 'enabled' : 'disabled'}`);
  console.log('');

  const pages = await fetchAllPages();
  console.log(`Found ${pages.length} pages total`);
  console.log('');

  let processed = 0;
  let failed = 0;
  let totalChunks = 0;
  let attachmentsProcessed = 0;
  let attachmentsFailed = 0;
  const startTime = Date.now();

  for (const page of pages) {
    try {
      const content = await fetchPageContent(page.title);
      if (!content || !content.content) {
        console.log(`[SKIP] ${page.title} — empty or not found`);
        continue;
      }

      const chunks = splitText(content.content);
      const allowedGroups = getAllowedGroups(page.ns);
      await upsertChunks(
        page.pageid,
        page.title,
        page.ns,
        chunks,
        allowedGroups,
        new Date().toISOString()
      );

      processed++;
      totalChunks += chunks.length;

      // Process attachments
      if (ENABLE_ATTACHMENTS) {
        const files = await fetchPageFiles(page.title);
        if (files.length > 0) {
          console.log(`  [ATTACH] ${page.title} has ${files.length} file(s)`);
        }
        for (const filename of files) {
          try {
            const fileInfo = await fetchFileInfo(filename);
            if (!fileInfo) {
              console.log(`    [SKIP] File:${filename} — not found`);
              continue;
            }
            const buffer = await downloadFile(fileInfo.url);
            if (!buffer) {
              console.log(`    [SKIP] File:${filename} — download failed`);
              continue;
            }
            const result = await processAttachment(buffer, fileInfo.mime, filename);
            if (result.text && result.text.trim().length > 0) {
              const attChunks = splitText(result.text);
              await upsertAttachmentChunks(
                page.pageid,
                page.title,
                filename,
                fileInfo.mime,
                attChunks.map(c => c.text),
                allowedGroups,
                new Date().toISOString(),
                result.metadata
              );
              attachmentsProcessed++;
              console.log(`    [OK] File:${filename} → ${attChunks.length} chunks (${fileInfo.mime})`);
            } else {
              console.log(`    [META] File:${filename} → metadata only (${fileInfo.mime})`);
            }
          } catch (err) {
            attachmentsFailed++;
            console.error(`    [FAIL] File:${filename}:`, (err as Error).message);
          }
        }
      }

      if (processed % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${elapsed}s] Processed ${processed}/${pages.length} pages, ${totalChunks} chunks`);
      }
    } catch (err) {
      failed++;
      console.error(`[FAIL] ${page.title}:`, (err as Error).message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('=== Reindex Complete ===');
  console.log(`Total pages: ${pages.length}`);
  console.log(`Processed: ${processed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total chunks: ${totalChunks}`);
  console.log(`Attachments processed: ${attachmentsProcessed}`);
  console.log(`Attachments failed: ${attachmentsFailed}`);
  console.log(`Time: ${elapsed}s`);
}

reindexAll().catch((err) => {
  console.error('Reindex failed:', err);
  process.exit(1);
});
