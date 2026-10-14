import { readCredentials } from './credentials.js';

export interface UsageWindow {
  utilization: number;
  resets_at: string | null;
  locked_reason?: string | null;
}

export interface UsageResponse {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  extra_usage?: Record<string, unknown> | null;
  limits?: { kind: string; percent: number; resets_at: string | null; is_active: boolean; severity?: string }[];
  [k: string]: unknown;
}

export interface Usage {
  fiveHourPct: number;
  fiveHourResetsAt: Date | null;
  fiveHourActive: boolean;
  sevenDayPct: number;
  sevenDayResetsAt: Date | null;
  locked: boolean;
  raw: UsageResponse | null;
}

export function parseUsage(raw: UsageResponse): Usage {
  const session = raw.limits?.find((l) => l.kind === 'session');
  const fh = raw.five_hour;
  const sd = raw.seven_day;
  return {
    fiveHourPct: fh?.utilization ?? 0,
    fiveHourResetsAt: fh?.resets_at ? new Date(fh.resets_at) : null,
    fiveHourActive: session?.is_active ?? (fh?.utilization ?? 0) > 0,
    sevenDayPct: sd?.utilization ?? 0,
    sevenDayResetsAt: sd?.resets_at ? new Date(sd.resets_at) : null,
    locked: Boolean(fh?.locked_reason) || (fh?.utilization ?? 0) >= 100 || (sd?.utilization ?? 0) >= 100,
    raw,
  };
}

let cache: { at: number; usage: Usage } | undefined;

/** Subscription usage from Anthropic's OAuth usage endpoint; cached, last value reused on 429. */
export async function fetchUsage(maxAgeMs = 60_000, fetchImpl: typeof fetch = fetch): Promise<Usage> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.usage;
  try {
    const { accessToken } = await readCredentials();
    const r = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`usage endpoint ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const usage = parseUsage((await r.json()) as UsageResponse);
    cache = { at: Date.now(), usage };
    return usage;
  } catch (e) {
    if (cache && /429|rate limit/i.test((e as Error).message)) return cache.usage;
    throw e;
  }
}

export function resetUsageCache(): void {
  cache = undefined;
}
