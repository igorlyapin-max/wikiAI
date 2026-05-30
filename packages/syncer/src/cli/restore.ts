import { config } from '../config.js';

async function restoreCollection(snapshotPath: string): Promise<void> {
  const collection = config.qdrantCollection;
  const qdrantUrl = config.qdrantUrl;

  console.log(`=== Qdrant Restore: ${collection} ===`);
  console.log(`Snapshot: ${snapshotPath}`);

  const fs = await import('fs');
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Snapshot file not found: ${snapshotPath}`);
  }

  const fileName = snapshotPath.split('/').pop()!;

  // Upload snapshot to Qdrant using multipart/form-data
  console.log('Uploading snapshot...');
  const fileBuffer = await fs.promises.readFile(snapshotPath);
  const blob = new Blob([fileBuffer]);
  const formData = new FormData();
  formData.append('snapshot', blob, fileName);

  const uploadRes = await fetch(`${qdrantUrl}/collections/${collection}/snapshots/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Failed to upload snapshot: ${uploadRes.status} ${err}`);
  }

  console.log(`Uploaded: ${fileName}`);

  // Recover collection from snapshot
  console.log('Recovering collection...');
  const recoverRes = await fetch(`${qdrantUrl}/collections/${collection}/snapshots/recover`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location: `${qdrantUrl}/collections/${collection}/snapshots/${fileName}`,
    }),
  });

  if (!recoverRes.ok) {
    const err = await recoverRes.text();
    throw new Error(`Failed to recover: ${recoverRes.status} ${err}`);
  }

  console.log('Restore complete.');
}

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  console.error('Usage: tsx restore.ts <snapshot-file>');
  process.exit(1);
}

restoreCollection(snapshotPath).catch((err) => {
  console.error('Restore failed:', err);
  process.exit(1);
});
