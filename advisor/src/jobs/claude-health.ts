import type { AppContext } from '../context.js';
import { credentialsHealth } from '../claude/credentials.js';
import { runSingleShot } from '../claude/runner.js';
import { getState, setState, recordClaudeCall } from '../db/repo/misc.js';
import { scoped } from '../log.js';

const log = scoped('jobs.claude-health');

export const REAUTH_RUNBOOK = [
  '⚠️ O assistente perdeu o acesso ao Claude e vai parar de responder até alguém religar.',
  'Nada foi alterado nos seus registros; extratos que chegarem ficam guardados.',
  'Para religar: no servidor do assistente, rode "docker compose exec -it advisor claude login", abra o link que aparecer em qualquer aparelho e conclua o login.',
].join('\n');

/**
 * Daily: read the credential file; when it expires within 48 h or is missing, ping Claude once
 * (cheapest model) and alert with the runbook if the ping fails. Not gated: one tiny call per day.
 */
export async function claudeHealthJob(ctx: AppContext, force = false): Promise<{ ok: boolean; detail: string }> {
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: ctx.config.TZ });
  const last = await getState<{ day: string; ok: boolean; detail: string }>(ctx.db, 'claude_health');
  if (!force && last?.day === day && last.ok) return { ok: true, detail: last.detail };

  const cred = await credentialsHealth();
  let ok = cred.loggedIn;
  let detail = cred.loggedIn ? `credentials present, expires in ${cred.expiresInHours ?? '?'} h (${cred.subscriptionType ?? 'unknown plan'})` : `no credentials: ${cred.error}`;
  const needsPing = force || !cred.loggedIn || (cred.expiresInHours !== null && cred.expiresInHours < 48);
  if (needsPing && cred.loggedIn) {
    const started = new Date();
    try {
      const r = await runSingleShot({
        bin: ctx.config.CLAUDE_BIN,
        systemPrompt: 'Reply with the JSON {"pong":true}. Nothing else.',
        jsonSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'] },
        input: 'ping',
        model: ctx.config.HEALTH_MODEL,
        effort: 'low',
        timeoutMs: 120_000,
      });
      await recordClaudeCall(ctx.db, {
        conversation_id: null,
        claude_session_id: r.sessionId,
        mode: 'single',
        model: ctx.config.HEALTH_MODEL,
        started_at: started,
        duration_ms: r.durationMs,
        exit_code: r.exitCode,
        usage: r.usage,
        cost_usd: r.costUsd,
        error: null,
      });
      ok = true;
      detail += '; ping ok (token refreshed by the CLI if needed)';
    } catch (err) {
      ok = false;
      detail += `; ping failed: ${(err as Error).message.slice(0, 300)}`;
      await recordClaudeCall(ctx.db, {
        conversation_id: null,
        claude_session_id: null,
        mode: 'single',
        model: ctx.config.HEALTH_MODEL,
        started_at: started,
        duration_ms: Date.now() - started.getTime(),
        exit_code: null,
        usage: null,
        cost_usd: null,
        error: (err as Error).message,
      });
    }
  }
  await setState(ctx.db, 'claude_health', { day, at: new Date().toISOString(), ok, detail });
  ctx.bus.emitGlobal({ type: 'health', claude: ok });
  if (!ok && last?.ok !== false) {
    await ctx.notifier.alert(`${REAUTH_RUNBOOK}\n\n${detail}`);
  }
  log.info({ ok, detail }, 'claude health');
  return { ok, detail };
}
