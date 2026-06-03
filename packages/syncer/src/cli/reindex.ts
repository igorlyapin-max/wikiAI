import { config } from '../config.js';
import { runReindex } from '../services/reindex.js';

const ENABLE_ATTACHMENTS = process.env.ENABLE_ATTACHMENTS !== 'false';

async function main(): Promise<void> {
  console.log('=== Full Wiki Reindex ===');
  console.log(`Chunk size: ${config.chunkSize}, overlap: ${config.chunkOverlap}`);
  console.log(`Attachments: ${ENABLE_ATTACHMENTS ? 'enabled' : 'disabled'}`);
  console.log(`Semantic facts: ${config.smwSyncEnabled ? 'enabled' : 'disabled'}`);
  console.log('');

  const summary = await runReindex(
    {
      attachmentsEnabled: ENABLE_ATTACHMENTS,
      semanticFactsEnabled: config.smwSyncEnabled,
    },
    (progress) => {
      if (progress.phase === 'started') {
        console.log(`Matched ${progress.matchedPages ?? progress.totalPages} pages`);
        console.log(`Queued ${progress.totalPages} pages${progress.limitApplied ? ` (limit ${progress.limitApplied})` : ''}`);
        console.log('');
      }
      if (progress.phase === 'page' && progress.processed > 0 && progress.processed % 10 === 0) {
        console.log(`Processed ${progress.processed}/${progress.totalPages} pages, skipped ${progress.skipped ?? 0}, ${progress.totalChunks} chunks`);
      }
    }
  );

  console.log('');
  console.log('=== Reindex Complete ===');
  console.log(`Namespaces: ${summary.namespaces.join(', ')}`);
  console.log(`Matched pages: ${summary.matchedPages}`);
  console.log(`Queued pages: ${summary.totalPages}${summary.limitApplied ? ` (limit ${summary.limitApplied})` : ''}`);
  console.log(`Processed: ${summary.processed}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Total chunks: ${summary.totalChunks}`);
  console.log(`Attachments processed: ${summary.attachmentsProcessed}`);
  console.log(`Attachments failed: ${summary.attachmentsFailed}`);
  console.log(`Time: ${(summary.elapsedMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('Reindex failed:', err);
  process.exit(1);
});
