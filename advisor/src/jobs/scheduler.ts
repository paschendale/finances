import type { AppContext } from '../context.js';
import { fetchUsage, type Usage } from '../claude/usage.js';
import { evaluateGate, idleMinutesFrom, type GateDecision } from '../claude/gate.js';
import { many } from '../db/client.js';
import { recordUsageSnapshot, setState } from '../db/repo/misc.js';
import { scoped } from '../log.js';

const log = scoped('scheduler');

export type Job = { name: string; run: (ctx: AppContext) => Promise<void> };

/** Gate check for routine Claude work; records a usage snapshot and the decision every time. */
export async function routineGate(ctx: AppContext): Promise<GateDecision & { usage: Usage | null }> {
  let usage: Usage | null = null;
  try {
    usage = await fetchUsage();
  } catch (err) {
    const d = { open: false, reason: `usage unavailable: ${(err as Error).message}`, usage: null };
    await setState(ctx.db, 'last_gate', { at: new Date().toISOString(), ...d, usage: undefined });
    return d;
  }
  const windowStart = usage.fiveHourResetsAt ? new Date(usage.fiveHourResetsAt.getTime() - 5 * 3_600_000) : new Date(Date.now() - 5 * 3_600_000);
  const snaps = await many<{ at: Date; five_hour_pct: number }>(ctx.db, 'SELECT at, five_hour_pct FROM advisor_usage_snapshots WHERE at >= $1 ORDER BY at', [windowStart]);
  const calls = await many<{ started_at: Date }>(ctx.db, 'SELECT started_at FROM advisor_claude_calls WHERE started_at >= $1 AND error IS NULL', [windowStart]);
  const idle = idleMinutesFrom(
    usage,
    snaps.map((s) => ({ at: new Date(s.at), pct: Number(s.five_hour_pct) })),
    calls.map((c) => ({ startedAt: new Date(c.started_at) })),
  );
  const decision = evaluateGate(usage, calls.length, idle, ctx.config);
  await recordUsageSnapshot(ctx.db, {
    five_hour_pct: usage.fiveHourPct,
    five_hour_resets_at: usage.fiveHourResetsAt?.toISOString() ?? null,
    seven_day_pct: usage.sevenDayPct,
    seven_day_resets_at: usage.sevenDayResetsAt?.toISOString() ?? null,
    locked: usage.locked,
    decision: decision.open ? 'open' : 'closed',
    reason: decision.reason,
  });
  await setState(ctx.db, 'last_gate', { at: new Date().toISOString(), open: decision.open, reason: decision.reason, five_hour_pct: usage.fiveHourPct, seven_day_pct: usage.sevenDayPct });
  return { ...decision, usage };
}

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  every(ms: number, job: Job, runAtStart = false): void {
    const tick = async () => {
      if (this.running.has(job.name)) return;
      this.running.add(job.name);
      const started = Date.now();
      try {
        await job.run(this.ctx);
        log.debug({ job: job.name, ms: Date.now() - started }, 'job done');
      } catch (err) {
        log.error({ job: job.name, err }, 'job failed');
      } finally {
        this.running.delete(job.name);
      }
    };
    const t = setInterval(() => void tick(), ms);
    t.unref();
    this.timers.push(t);
    if (runAtStart) setTimeout(() => void tick(), 2_000).unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
