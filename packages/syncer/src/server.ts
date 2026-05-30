import Fastify from 'fastify';
import { config } from './config.js';
import { fetchPageContent } from './services/mediawiki.js';
import { splitText } from './services/chunker.js';
import { upsertChunks } from './services/qdrant.js';
import { getAllowedGroups } from './services/acl.js';

const app = Fastify({ logger: true });

interface WebhookBody {
  event: 'edit' | 'delete' | 'move' | 'protect';
  page_id: number;
  title: string;
  namespace: number;
  timestamp: string;
}

app.post('/webhook/page', async (request, reply) => {
  const body = request.body as WebhookBody;
  console.log('Webhook received:', body.event, body.title);

  if (body.event === 'delete') {
    // Delete all chunks for page
    const { qdrant } = await import('./services/qdrant.js');
    await qdrant.delete(config.qdrantCollection, {
      filter: { must: [{ key: 'page_id', match: { value: body.page_id } }] },
    });
    reply.send({ status: 'deleted', page_id: body.page_id });
    return;
  }

  if (body.event === 'edit' || body.event === 'move' || body.event === 'protect') {
    const page = await fetchPageContent(body.title);
    if (!page || !page.content) {
      reply.status(404).send({ error: 'Page not found or empty' });
      return;
    }

    const chunks = splitText(page.content);
    const allowedGroups = getAllowedGroups(page.ns);
    await upsertChunks(page.pageid, page.title, page.ns, chunks, allowedGroups, body.timestamp);

    reply.send({
      status: 'indexed',
      page_id: page.pageid,
      title: page.title,
      chunks: chunks.length,
      allowed_groups: allowedGroups,
    });
    return;
  }

  reply.status(400).send({ error: 'Unknown event' });
});

app.get('/health', async () => ({ status: 'ok' }));

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.syncerPort, host: '0.0.0.0' });
    console.log(`Syncer listening on http://0.0.0.0:${config.syncerPort}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
