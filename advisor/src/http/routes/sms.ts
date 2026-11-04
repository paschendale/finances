import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ingestSms } from '../../jobs/ingest-sms.js';
import { scoped } from '../../log.js';

const log = scoped('http.sms');

const bodySchema = z.object({
  text: z.string().min(1).max(2000),
  sender: z.string().max(100).nullish(),
  received_at: z.string().max(40).nullish(),
});

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * POST /sms  — a phone automation forwards a bank SMS. Its own long-lived secret (SMS_TOKEN), not
 * the web JWT, which expires. Answers at once and records in the background, since picking the
 * category calls Claude and a phone shortcut should not wait for that.
 */
export function smsRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  app.post('/sms', async (c) => {
    const expected = ctx.config.SMS_TOKEN;
    if (!expected) return c.json({ error: 'sms intake is not enabled' }, 404);
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !sameToken(token, expected)) return c.json({ error: 'invalid token' }, 401);

    const type = c.req.header('content-type') ?? '';
    const raw = type.includes('application/json') ? await c.req.json().catch(() => null) : { text: await c.req.text() };
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'expected {"text": "<the SMS>"}' }, 400);
    const body = parsed.data;
    void ingestSms(ctx, body).catch(async (err) => {
      log.error({ err }, 'sms ingest failed');
      await ctx.notifier.alert(`⚠️ Não consegui registrar uma compra que chegou por SMS. Mensagem: ${body.text.slice(0, 200)}`).catch(() => undefined);
    });
    return c.json({ ok: true }, 202);
  });
  return app;
}
