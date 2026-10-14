import { describe, expect, it } from 'vitest';
import { evaluateGate, idleMinutesFrom } from '../src/claude/gate.js';
import { parseUsage, type Usage } from '../src/claude/usage.js';

const cfg = { GATE_MAX_7D_PCT: 85, GATE_MAX_5H_PCT: 70, GATE_MAX_CALLS_PER_WINDOW: 40, GATE_TAIL_MINUTES: 60, GATE_IDLE_MINUTES: 15 };
const now = new Date('2026-10-14T12:00:00Z');

function usage(partial: Partial<Usage>): Usage {
  return { fiveHourPct: 0, fiveHourResetsAt: null, fiveHourActive: false, sevenDayPct: 0, sevenDayResetsAt: null, locked: false, raw: null, ...partial };
}

describe('evaluateGate (routine work only)', () => {
  it('closes when locked', () => {
    expect(evaluateGate(usage({ locked: true }), 0, Infinity, cfg, now).open).toBe(false);
  });
  it('closes above the weekly ceiling', () => {
    expect(evaluateGate(usage({ sevenDayPct: 90 }), 0, Infinity, cfg, now)).toMatchObject({ open: false, reason: expect.stringContaining('7d') });
  });
  it('closes at the call cap', () => {
    expect(evaluateGate(usage({}), 40, Infinity, cfg, now).open).toBe(false);
  });
  it('opens with no active 5h window', () => {
    expect(evaluateGate(usage({}), 3, Infinity, cfg, now)).toMatchObject({ open: true, reason: 'no active window' });
  });
  it('closes above the 5h ceiling', () => {
    expect(evaluateGate(usage({ fiveHourActive: true, fiveHourPct: 75, fiveHourResetsAt: new Date(now.getTime() + 3 * 3600_000) }), 0, 0, cfg, now).open).toBe(false);
  });
  it('opens in the tail of the window', () => {
    const u = usage({ fiveHourActive: true, fiveHourPct: 40, fiveHourResetsAt: new Date(now.getTime() + 30 * 60_000) });
    expect(evaluateGate(u, 0, 0, cfg, now)).toMatchObject({ open: true, reason: expect.stringContaining('min left') });
  });
  it('opens after idle minutes, closes otherwise', () => {
    const u = usage({ fiveHourActive: true, fiveHourPct: 40, fiveHourResetsAt: new Date(now.getTime() + 3 * 3600_000) });
    expect(evaluateGate(u, 0, 20, cfg, now).open).toBe(true);
    expect(evaluateGate(u, 0, 5, cfg, now).open).toBe(false);
  });
});

describe('idleMinutesFrom', () => {
  const resets = new Date(now.getTime() + 2 * 3600_000);
  const u = usage({ fiveHourActive: true, fiveHourPct: 30, fiveHourResetsAt: resets });
  it('is infinite without an active window', () => {
    expect(idleMinutesFrom(usage({}), [], [], now)).toBe(Infinity);
  });
  it('resets on a usage jump not caused by us', () => {
    const t = (m: number) => new Date(now.getTime() - m * 60_000);
    const snaps = [
      { at: t(120), pct: 10 },
      { at: t(60), pct: 20 },
      { at: t(10), pct: 30 },
    ];
    expect(Math.round(idleMinutesFrom(u, snaps, [], now))).toBe(10);
    // the last jump was ours → idleness carries through it
    expect(Math.round(idleMinutesFrom(u, snaps, [{ startedAt: t(30) }], now))).toBe(60);
  });
});

describe('parseUsage', () => {
  it('maps the OAuth usage payload', () => {
    const u = parseUsage({
      five_hour: { utilization: 49, resets_at: '2026-10-14T15:30:00Z' },
      seven_day: { utilization: 13, resets_at: '2026-10-20T05:00:00Z' },
      limits: [{ kind: 'session', percent: 49, resets_at: null, is_active: true }],
    });
    expect(u.fiveHourPct).toBe(49);
    expect(u.fiveHourActive).toBe(true);
    expect(u.locked).toBe(false);
    expect(u.sevenDayResetsAt?.toISOString()).toBe('2026-10-20T05:00:00.000Z');
  });
});
