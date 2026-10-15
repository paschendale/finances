import { Hono, type Context } from 'hono';
import type { AppContext } from '../../context.js';
import type { Actor } from '../auth.js';
import { createConversation, getConversation } from '../../db/repo/conversations.js';
import { ingestBuffer, IngestError } from '../../jobs/ingest-statement.js';

type Env = { Variables: { actor: Actor } };

/**
 * POST /conversations/:id/uploads  (multipart: file[, message])
 * POST /uploads                     (multipart: file[, message]) → new conversation
 */
export function uploadRoutes(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();
  const maxBytes = ctx.config.UPLOAD_MAX_MB * 1024 * 1024;

  async function handle(c: Context<Env>, conversationId: string | null) {
    const len = Number(c.req.header('content-length') ?? '0');
    if (len > maxBytes + 4096) return c.json({ error: `upload exceeds ${ctx.config.UPLOAD_MAX_MB} MB` }, 413);
    const body = await c.req.parseBody({ all: true });
    const files = ([] as unknown[]).concat(body['file'] ?? body['files'] ?? []).filter((f): f is File => f instanceof File);
    if (files.length === 0) return c.json({ error: 'no file field' }, 400);
    const message = typeof body['message'] === 'string' ? (body['message'] as string) : '';
    const actor = c.get('actor');

    let convId = conversationId;
    if (!convId) {
      const title = (message.trim() ? message.trim().replace(/\s+/g, ' ') : files[0]!.name).slice(0, 60);
      const conv = await createConversation(ctx.db, { channel: 'web', title, created_by: actor.id });
      convId = conv.id;
    } else if (!(await getConversation(ctx.db, convId))) {
      return c.json({ error: 'conversation not found' }, 404);
    }

    const results = [];
    for (const f of files) {
      const buf = Buffer.from(await f.arrayBuffer());
      if (buf.length > maxBytes) return c.json({ error: `${f.name} exceeds ${ctx.config.UPLOAD_MAX_MB} MB` }, 413);
      try {
        const r = await ingestBuffer(ctx, { buffer: buf, filename: f.name, source: 'upload', conversationId: convId, actor: actor.id, message: message || null, kind: 'interactive' });
        results.push(r);
      } catch (err) {
        if (err instanceof IngestError) return c.json({ error: err.message }, err.status as 400);
        throw err;
      }
    }
    return c.json({ conversation_id: convId, statements: results }, 201);
  }

  app.post('/uploads', (c) => handle(c, null));
  app.post('/conversations/:id/uploads', (c) => handle(c, c.req.param('id')));
  return app;
}
