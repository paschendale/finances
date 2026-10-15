import type { Usage } from './usage.js';

export interface GateConfig {
  GATE_MAX_7D_PCT: number;
  GATE_MAX_5H_PCT: number;
  GATE_MAX_CALLS_PER_WINDOW: number;
  GATE_TAIL_MINUTES: number;
  GATE_IDLE_MINUTES: number;
}

export interface GateDecision {
  open: boolean;
  reason: string;
}

/**
 * Gate for ROUTINE work only (docs/ADVISOR.md §6.1). Interactive turns never call this.
 * Port of territorial-assistant's evaluateGate: run background Claude work only when the
 * subscription windows are quiet enough that a person using the same subscription is not
 * crowded out.
 */
export function evaluateGate(u: Usage, callsThisWindow: number, idleMins: number, c: GateConfig, now = new Date()): GateDecision {
  if (u.locked) return { open: false, reason: 'locked' };
  if (u.sevenDayPct > c.GATE_MAX_7D_PCT) return { open: false, reason: `7d ${u.sevenDayPct}% > ${c.GATE_MAX_7D_PCT}%` };
  if (callsThisWindow >= c.GATE_MAX_CALLS_PER_WINDOW) return { open: false, reason: `calls ${callsThisWindow} >= max ${c.GATE_MAX_CALLS_PER_WINDOW}` };
  if (!u.fiveHourActive) return { open: true, reason: 'no active window' };
  if (u.fiveHourPct > c.GATE_MAX_5H_PCT) return { open: false, reason: `5h ${u.fiveHourPct}% > ${c.GATE_MAX_5H_PCT}%` };
  const minsLeft = u.fiveHourResetsAt ? (u.fiveHourResetsAt.getTime() - now.getTime()) / 60_000 : Infinity;
  if (minsLeft <= c.GATE_TAIL_MINUTES) return { open: true, reason: `5h ${u.fiveHourPct}%, ${Math.round(minsLeft)} min left` };
  if (idleMins >= c.GATE_IDLE_MINUTES) return { open: true, reason: `idle ${Math.round(idleMins)} min, 5h ${u.fiveHourPct}%` };
  return {
    open: false,
    reason: `${Math.round(minsLeft)} min left > tail ${c.GATE_TAIL_MINUTES}, idle ${Math.round(idleMins)} min < ${c.GATE_IDLE_MINUTES}`,
  };
}

/**
 * Interactive work is never gated. This exists so callers can show a useful message when
 * Anthropic itself has locked the subscription; it never blocks a user's turn pre-emptively.
 */
export function describeInteractiveLock(u: Usage | null): string | null {
  if (!u || !u.locked) return null;
  return `Claude usage window is exhausted; resets ${u.fiveHourResetsAt?.toISOString() ?? 'later'}`;
}

/**
 * Minutes the 5h window has sat idle from the daemon's perspective: time since the last usage
 * increase that was not caused by one of our own calls. Snapshots and calls come from the DB.
 */
export function idleMinutesFrom(
  u: Usage,
  snapshots: { at: Date; pct: number }[],
  ownCalls: { startedAt: Date }[],
  now = new Date(),
): number {
  if (!u.fiveHourActive || !u.fiveHourResetsAt) return Infinity;
  const windowStart = new Date(u.fiveHourResetsAt.getTime() - 5 * 3_600_000);
  let idleSince = windowStart;
  const snaps = snapshots.filter((s) => s.at >= windowStart).sort((a, b) => a.at.getTime() - b.at.getTime());
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1]!;
    const curr = snaps[i]!;
    if (curr.pct <= prev.pct) continue;
    const own = ownCalls.some((c) => c.startedAt > prev.at && c.startedAt <= curr.at);
    if (!own) idleSince = curr.at;
  }
  return (now.getTime() - idleSince.getTime()) / 60_000;
}
