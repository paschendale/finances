import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Actor } from '../auth.js';

type Env = { Variables: { actor: Actor } };

const searchSchema = z.object({ q: z.string().min(1).max(500).default('has:attachment newer_than:45d'), limit: z.coerce.number().int().min(1).max(50).default(20) });
const ingestSchema = z.object({ force: z.boolean().optional(), plan: z.boolean().optional() });

/** Manual Gmail pick-up: "is the card statement in the mailbox?" and "ingest that mail now". */
export function gmailRoutes(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/gmail/messages', async (c) => {
    if (!ctx.gmail) return c.json({ error: 'gmail channel is not enabled' }, 404);
    const q = searchSchema.parse({ q: c.req.query('q') ?? undefined, limit: c.req.query('limit') ?? undefined });
    return c.json(await ctx.gmail.search(q.q, q.limit));
  });

  app.post('/gmail/messages/:id/ingest', async (c) => {
    if (!ctx.gmail) return c.json({ error: 'gmail channel is not enabled' }, 404);
    const body = ingestSchema.parse(await c.req.json().catch(() => ({})));
    const actor = c.get('actor');
    const r = await ctx.gmail.ingestMessage(c.req.param('id'), { actor: actor.id, force: body.force, plan: body.plan });
    return c.json(r, r.conversation_id ? 202 : 200);
  });

  return app;
}
