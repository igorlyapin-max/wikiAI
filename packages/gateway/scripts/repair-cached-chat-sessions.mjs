#!/usr/bin/env node
import { Client } from 'pg';

function readArg(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const apply = process.argv.includes('--apply');
const targetUserId = Number(readArg('--target-user-id', process.env.CHAT_REPAIR_TARGET_USER_ID ?? '2'));
const targetUsername = readArg('--target-username', process.env.CHAT_REPAIR_TARGET_USERNAME ?? 'Admin');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
  console.error('--target-user-id must be a positive integer');
  process.exit(2);
}

if (!targetUsername.trim()) {
  console.error('--target-username must not be empty');
  process.exit(2);
}

const client = new Client({ connectionString: databaseUrl });

async function recomputeSession(sessionId) {
  await client.query(
    `UPDATE ai_chat_sessions
     SET message_count = (
           SELECT COUNT(*)::int FROM ai_chat_messages WHERE session_id = $1
         ),
         last_message_at = (
           SELECT MAX(created_at) FROM ai_chat_messages WHERE session_id = $1
         ),
         updated_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );
}

async function main() {
  await client.connect();
  const cached = await client.query(
    `SELECT id, conversation_id, user_id, username, status, message_count
     FROM ai_chat_sessions
     WHERE user_id = 0 AND username = 'cached'
     ORDER BY created_at ASC`
  );

  const actions = [];
  for (const session of cached.rows) {
    const existing = await client.query(
      `SELECT id, conversation_id, message_count
       FROM ai_chat_sessions
       WHERE user_id = $1 AND conversation_id = $2 AND id <> $3
       LIMIT 1`,
      [targetUserId, session.conversation_id, session.id]
    );

    if (existing.rows[0]) {
      actions.push({
        type: 'merge_conflict',
        legacySessionId: session.id,
        targetSessionId: existing.rows[0].id,
        conversationId: session.conversation_id,
        messageCount: session.message_count,
      });
    } else {
      actions.push({
        type: 'update_owner',
        legacySessionId: session.id,
        conversationId: session.conversation_id,
        messageCount: session.message_count,
      });
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    targetUserId,
    targetUsername,
    cachedSessions: cached.rowCount,
    updateOwner: actions.filter((action) => action.type === 'update_owner').length,
    mergeConflict: actions.filter((action) => action.type === 'merge_conflict').length,
    actions,
  }, null, 2));

  if (!apply || actions.length === 0) return;

  await client.query('BEGIN');
  try {
    for (const action of actions) {
      if (action.type === 'update_owner') {
        await client.query(
          `UPDATE ai_chat_sessions
           SET user_id = $1,
               username = $2,
               updated_at = NOW(),
               metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                 || jsonb_build_object('cachedUserRepair', jsonb_build_object(
                      'repairedAt', NOW(),
                      'mode', 'owner_update'
                    ))
           WHERE id = $3`,
          [targetUserId, targetUsername, action.legacySessionId]
        );
        continue;
      }

      await client.query(
        `UPDATE ai_chat_messages
         SET session_id = $1
         WHERE session_id = $2`,
        [action.targetSessionId, action.legacySessionId]
      );
      await recomputeSession(action.targetSessionId);
      await client.query(
        `UPDATE ai_chat_sessions
         SET user_id = $1,
             username = $2,
             conversation_id = conversation_id || '#legacy-merged-' || left(id, 8),
             status = 'deleted',
             message_count = 0,
             deleted_at = NOW(),
             updated_at = NOW(),
             metadata_json = COALESCE(metadata_json, '{}'::jsonb)
               || jsonb_build_object('cachedUserRepair', jsonb_build_object(
                    'repairedAt', NOW(),
                    'mode', 'merged_into_existing_session',
                    'targetSessionId', $3::text,
                    'originalConversationId', $4::text
                  ))
         WHERE id = $5`,
        [targetUserId, `${targetUsername} (legacy merged)`, action.targetSessionId, action.conversationId, action.legacySessionId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => undefined);
  });
