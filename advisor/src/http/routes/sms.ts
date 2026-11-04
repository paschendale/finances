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
    // Every attempt is logged (never the token or the text), so a phone automation that "did nothing" can be traced.
    const meta = { contentType: c.req.header('content-type') ?? null, length: Number(c.req.header('content-length') ?? 0), ua: (c.req.header('user-agent') ?? '').slice(0, 80) };
    const reply = (status: 202 | 400 | 401 | 404, body: Record<string, unknown>, reason: string) => {
      log.info({ status, reason, ...meta }, 'sms request');
      return c.json(body, status);
    };
    const expected = ctx.config.SMS_TOKEN;
    if (!expected) return reply(404, { error: 'O recebimento de SMS não está ligado no servidor.' }, 'disabled');
    const header = c.req.header('authorization') ?? '';
    if (!header) return reply(401, { error: 'Faltou o cabeçalho Authorization: Bearer <chave>.' }, 'no authorization header');
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token || !sameToken(token, expected)) return reply(401, { error: 'Chave errada. Confira o cabeçalho Authorization: Bearer <chave>.' }, header.startsWith('Bearer') ? 'wrong token' : 'authorization without Bearer');

    const type = meta.contentType ?? '';
    const rawText = await c.req.text();
    let raw: unknown = { text: rawText };
    if (type.includes('json') || rawText.trim().startsWith('{')) {
      try {
        raw = JSON.parse(rawText);
      } catch {
        raw = { text: rawText };
      }
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return reply(400, { error: 'Faltou o campo "text" com a mensagem do SMS.' }, `bad body: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ').slice(0, 200)}`);
    const body = parsed.data;
    void ingestSms(ctx, body).catch(async (err) => {
      log.error({ err }, 'sms ingest failed');
      await ctx.notifier.alert(`⚠️ Não consegui registrar uma compra que chegou por SMS. Mensagem: ${body.text.slice(0, 200)}`).catch(() => undefined);
    });
    return reply(202, { ok: true, mensagem: 'Recebido. A compra aparece no Discord em instantes.' }, `accepted (${body.text.length} chars)`);
  });
  return app;
}
