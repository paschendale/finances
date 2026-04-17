import { isAfter, parseISO, subDays } from 'date-fns';

/** True if the account should appear on the balance check-in list (never checked, or last check older than threshold). */
export function isBalanceCheckStale(
  lastChecked: string | null,
  now: Date = new Date(),
  thresholdDays = 7
): boolean {
  if (lastChecked == null) return true;
  const t = parseISO(lastChecked);
  const cutoff = subDays(now, thresholdDays);
  return !isAfter(t, cutoff);
}
