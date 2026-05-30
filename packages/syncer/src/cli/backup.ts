import { config } from '../config.js';

interface SnapshotInfo {
  name: string;
  size: number;
  creation_time: string;
}

async function backupCollection(): Promise<void> {
  const collection = config.qdrantCollection;
  const qdrantUrl = config.qdrantUrl;
  const backupDir = process.env.BACKUP_DIR ?? './backups';

  console.log(`=== Qdrant Backup: ${collection} ===`);
  console.log(`URL: ${qdrantUrl}`);

  // Create snapshot
  console.log('Creating snapshot...');
  const createRes = await fetch(`${qdrantUrl}/collections/${collection}/snapshots`, {
    method: 'POST',
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Failed to create snapshot: ${createRes.status} ${err}`);
  }
  const createData = (await createRes.json()) as { result: { name: string } };
  const snapshotName = createData.result.name;
  console.log(`Snapshot created: ${snapshotName}`);

  // Download snapshot
  const downloadUrl = `${qdrantUrl}/collections/${collection}/snapshots/${snapshotName}`;
  console.log(`Downloading from ${downloadUrl}...`);
  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download snapshot: ${downloadRes.status}`);
  }

  const fs = await import('fs');
  const path = await import('path');
  await fs.promises.mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${collection}-${timestamp}.snapshot`;
  const filePath = path.join(backupDir, fileName);

  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  await fs.promises.writeFile(filePath, buffer);

  console.log(`Backup saved: ${filePath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

  // Clean up old snapshots (keep last 10)
  const listRes = await fetch(`${qdrantUrl}/collections/${collection}/snapshots`);
  const listData = (await listRes.json()) as { result: SnapshotInfo[] };
  const snapshots = listData.result ?? [];

  if (snapshots.length > 10) {
    const toDelete = snapshots
      .sort((a, b) => new Date(a.creation_time).getTime() - new Date(b.creation_time).getTime())
      .slice(0, snapshots.length - 10);

    for (const snap of toDelete) {
      console.log(`Deleting old snapshot: ${snap.name}`);
      await fetch(`${qdrantUrl}/collections/${collection}/snapshots/${snap.name}`, {
        method: 'DELETE',
      });
    }
  }

  console.log('Backup complete.');
}

backupCollection().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});
