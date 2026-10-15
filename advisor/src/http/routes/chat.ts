import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Actor } from '../auth.js';
import {
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  updateConversation,
} from '../../db/repo/conversations.js';
import { listPlans } from '../../db/repo/plans.js';
import { listStatements } from '../../db/repo/statements.js';

type Env = { Variables: { actor: Actor } };

const createSchema = z.object({ title: z.string().max(120).optional(), message: z.string().max(20_000).optional(), context: z.string().max(4000).optional() });
const messageSchema = z.object({ content: z.string().min(1).max(20_000) });
const patchSchema = z.object({ title: z.string().min(1).max(120).optional(), status: z.enum(['active', 'archived']).optional() });

export function chatRoutes(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/conversations', async (c) => {
    const rows = await listConversations(ctx.db, { includeArchived: c.req.query('archived') === '1' || true });
    return c.json(rows);
  });

  app.post('/conversations', async (c) => {
    const body = createSchema.parse(await c.req.json().catch(() => ({})));
    const actor = c.get('actor');
    const conv = await createConversation(ctx.db, { channel: 'web', title: body.title, created_by: actor.id });
    if (body.message) {
      void ctx.sessions.sendUserMessage(conv.id, body.message, { actor: actor.id, kind: 'interactive', context: body.context });
    }
    return c.json(conv, 201);
  });

  app.get('/conversations/:id', async (c) => {
    const conv = await getConversation(ctx.db, c.req.param('id'));
    if (!conv) return c.json({ error: 'not found' }, 404);
    const [messages, plans, statements] = await Promise.all([
      listMessages(ctx.db, conv.id),
      listPlans(ctx.db, { conversation_id: conv.id }),
      listStatements(ctx.db, { conversation_id: conv.id }),
    ]);
    return c.json({
      conversation: conv,
      messages,
      plans,
      statements: statements.map(({ lines, ...s }) => ({ ...s, line_count: lines?.length ?? 0 })),
      busy: ctx.sessions.isBusy(conv.id),
    });
  });

  app.patch('/conversations/:id', async (c) => {
    const body = patchSchema.parse(await c.req.json());
    const conv = await getConversation(ctx.db, c.req.param('id'));
    if (!conv) return c.json({ error: 'not found' }, 404);
    const updated = await updateConversation(ctx.db, conv.id, body);
    if (body.title) ctx.bus.emitConversation(conv.id, { type: 'conversation', field: 'title', value: body.title });
    if (body.status) ctx.bus.emitConversation(conv.id, { type: 'conversation', field: 'status', value: body.status });
    return c.json(updated);
  });

  app.post('/conversations/:id/messages', async (c) => {
    const body = messageSchema.parse(await c.req.json());
    const conv = await getConversation(ctx.db, c.req.param('id'));
    if (!conv) return c.json({ error: 'not found' }, 404);
    const actor = c.get('actor');
    // Turn runs in the background; the client follows it on the SSE stream.
    const outcome = ctx.sessions.sendUserMessage(conv.id, body.content, { actor: actor.id, kind: 'interactive' });
    outcome.catch(() => undefined);
    return c.json({ accepted: true, queued: ctx.sessions.isBusy(conv.id) }, 202);
  });

  app.post('/conversations/:id/stop', async (c) => {
    const stopped = ctx.sessions.stop(c.req.param('id'));
    return c.json({ stopped });
  });

  app.get('/conversations/:id/events', async (c) => {
    const conv = await getConversation(ctx.db, c.req.param('id'));
    if (!conv) return c.json({ error: 'not found' }, 404);
    return streamSSE(c, async (stream) => {
      let id = 0;
      const queue: string[] = [];
      let closed = false;
      const off = ctx.bus.onConversation(conv.id, (ev) => {
        queue.push(JSON.stringify(ev));
      });
      stream.onAbort(() => {
        closed = true;
        off();
      });
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ conversation_id: conv.id, busy: ctx.sessions.isBusy(conv.id) }), id: String(id++) });
      while (!closed) {
        while (queue.length > 0) {
          const data = queue.shift()!;
          await stream.writeSSE({ event: 'conversation', data, id: String(id++) });
        }
        await stream.sleep(150);
        if (id % 200 === 0) await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      }
    });
  });

  app.get('/events', async (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let closed = false;
      const offGlobal = ctx.bus.onGlobal((ev) => queue.push(JSON.stringify(ev)));
      const offConv = ctx.bus.onAnyConversation((conversationId, ev) => {
        if (ev.type === 'message' || ev.type === 'plan' || ev.type === 'conversation') queue.push(JSON.stringify({ type: 'conversation_activity', conversationId, event: ev }));
      });
      stream.onAbort(() => {
        closed = true;
        offGlobal();
        offConv();
      });
      await stream.writeSSE({ event: 'ready', data: '{}' });
      let n = 0;
      while (!closed) {
        while (queue.length > 0) await stream.writeSSE({ event: 'global', data: queue.shift()! });
        await stream.sleep(250);
        if (++n % 120 === 0) await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      }
    }),
  );

  return app;
}
