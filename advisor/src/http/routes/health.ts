import { Hono } from 'hono';
import type { AppContext } from '../../context.js';
import { credentialsHealth } from '../../claude/credentials.js';
import { getState } from '../../db/repo/misc.js';
import { one } from '../../db/client.js';

export interface ChannelStatus {
  name: string;
  enabled: boolean;
  ok: boolean;
  detail?: string;
}

export const channelStatus: Map<string, ChannelStatus> = new Map();

export function setChannelStatus(s: ChannelStatus): void {
  channelStatus.set(s.name, s);
}

export async function healthReport(ctx: AppContext): Promise<Record<string, unknown>> {
  let db: { ok: boolean; detail?: string } = { ok: false };
  let pending = 0;
  try {
    const row = await one<{ n: number; pending: number }>(
      ctx.db,
      `SELECT (SELECT count(*) FROM schema_migrations)::int AS n, (SELECT count(*) FROM advisor_plans WHERE status = 'pending_approval')::int AS pending`,
    );
    db = { ok: true, detail: `${row.n} migrations` };
    pending = row.pending;
  } catch (err) {
    db = { ok: false, detail: (err as Error).message };
  }
  const claude = await credentialsHealth();
  const lastHealth = await getState<{ at: string; ok: boolean; detail?: string }>(ctx.db, 'claude_health').catch(() => null);
  const gmailCursor = await getState<{ historyId?: string; at?: string }>(ctx.db, 'gmail_cursor').catch(() => null);
  const lastGate = await getState<{ at: string; open: boolean; reason: string }>(ctx.db, 'last_gate').catch(() => null);
  const ok = db.ok && claude.loggedIn;
  return {
    ok,
    env: ctx.config.ADVISOR_ENV,
    channels: [...ctx.config.channels],
    db,
    claude: { ...claude, last_ping: lastHealth },
    gate: lastGate,
    gmail: ctx.config.channels.has('gmail') ? { cursor: gmailCursor, status: channelStatus.get('gmail') ?? null } : null,
    discord: ctx.config.channels.has('discord') ? (channelStatus.get('discord') ?? { name: 'discord', enabled: true, ok: false, detail: 'starting' }) : null,
    sessions: ctx.pool.stats,
    pending_plans: pending,
    now: new Date().toISOString(),
  };
}

export function healthRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  app.get('/health', async (c) => {
    const report = await healthReport(ctx);
    return c.json(report, report.ok ? 200 : 503);
  });
  return app;
}
