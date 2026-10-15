import type { AppContext } from '../context.js';
import { many } from '../db/client.js';
import { getState, setState } from '../db/repo/misc.js';
import { listPlans } from '../db/repo/plans.js';
import { scoped } from '../log.js';

const log = scoped('jobs.nudges');

export interface DueAccount {
  account_id: string;
  account_name: string;
  account_type: string;
  balance: number;
  last_entry_date: string | null;
  last_checked: string | null;
  days_since_check: number | null;
  check_tier: string;
  check_due_on: string;
  check_reason: 'never_checked' | 'moved' | 'cadence';
}

/** Accounts due for a balance check; the cadence lives in the view account_check_status (migration 0057). */
export async function findDueAccounts(ctx: AppContext): Promise<DueAccount[]> {
  return many<DueAccount>(
    ctx.db,
    `SELECT ab.account_id, ab.account_name, ab.account_type, ab.balance, ab.last_entry_date, ab.last_checked,
            CASE WHEN ab.last_checked IS NULL THEN NULL ELSE (CURRENT_DATE - ab.last_checked::date) END AS days_since_check,
            ab.check_tier, ab.check_due_on::text AS check_due_on, ab.check_reason
     FROM account_balances ab
     WHERE ab.hidden = false AND ab.parent_id IS NULL AND ab.check_due
     ORDER BY ab.check_due_on, ab.account_name`,
  );
}

function todayKey(tz: string): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz });
}

const fmt = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);

const WEEK_MS = 7 * 86_400_000;

export interface StaleNudgeState {
  day: string;
  accounts: string[];
  posted_at?: string;
}

/**
 * Post when an account newly becomes due (not in the last nudge), else at most once a week while
 * any account stays due. Never twice on the same day.
 */
export function shouldNudge(due: string[], last: StaleNudgeState | null, today: string, now = Date.now()): boolean {
  if (due.length === 0) return false;
  if (!last) return true;
  if (last.day === today) return false;
  const known = new Set(last.accounts ?? []);
  if (due.some((id) => !known.has(id))) return true;
  const postedAt = Date.parse(last.posted_at ?? `${last.day}T12:00:00Z`);
  return !Number.isFinite(postedAt) || now - postedAt >= WEEK_MS;
}

export function dueReason(a: Pick<DueAccount, 'check_reason' | 'days_since_check'>): string {
  if (a.check_reason === 'never_checked') return 'nunca conferida';
  if (a.check_reason === 'moved') return 'teve movimento depois da última conferência';
  return a.days_since_check != null ? `conferida há ${a.days_since_check} dias` : 'passou do prazo de conferência';
}

/** Daily check, posts only per shouldNudge. No Claude call needed. */
export async function staleAccountsJob(ctx: AppContext): Promise<void> {
  const key = todayKey(ctx.config.TZ);
  const last = await getState<StaleNudgeState>(ctx.db, 'last_stale_nudge');
  const due = await findDueAccounts(ctx);
  if (!shouldNudge(due.map((a) => a.account_id), last, key)) return;
  const known = new Set(last?.accounts ?? []);
  const fresh = due.filter((a) => !known.has(a.account_id));
  await ctx.notifier.notice({
    key: 'stale-accounts',
    title: 'Contas para conferir',
    status: `🔔 ${due.length} conta${due.length > 1 ? 's' : ''} para conferir`,
    lines: fresh.length && fresh.length < due.length ? [`Novas desde o último aviso: ${fresh.slice(0, 3).map((a) => a.account_name).join(', ')}${fresh.length > 3 ? '…' : ''}`] : [],
    details: [...due.map((a) => `${a.account_name} · ${fmt(Number(a.balance))} · ${dueReason(a)}`), '', 'Para conferir, responda aqui com o saldo que aparece no banco ("Nubank tá com 657,21"), ou "sem movimento" se nada mudou, ou mande o extrato.'],
    context: `Balance-check nudge (cadence from account_check_status: busy accounts monthly, occasional ones 7 days after they move or every 90 days, idle accounts with money every 180 days, idle empty accounts and property never). Due now: ${due.map((a) => `${a.account_name} (${a.account_id}, balance ${a.balance}, last_checked ${a.last_checked ?? 'never'}, last entry ${a.last_entry_date ?? 'none'}, tier ${a.check_tier}, why ${a.check_reason})`).join('; ')}. The person replies with balances or "sem movimento"; follow the check-in procedure.`,
  });
  await setState(ctx.db, 'last_stale_nudge', { day: key, accounts: due.map((a) => a.account_id), posted_at: new Date().toISOString() } satisfies StaleNudgeState);
  log.info({ count: due.length, fresh: fresh.length }, 'balance check nudge posted');
}

/** Reminds once a day about plans pending for more than 24 h. */
export async function pendingPlansJob(ctx: AppContext): Promise<void> {
  const key = todayKey(ctx.config.TZ);
  const last = await getState<{ day: string }>(ctx.db, 'last_pending_reminder');
  if (last?.day === key) return;
  const plans = (await listPlans(ctx.db, { status: ['pending_approval'] })).filter((p) => Date.now() - new Date(p.updated_at).getTime() > 24 * 3_600_000);
  if (plans.length === 0) return;
  await ctx.notifier.notice({
    key: 'pending-plans',
    title: 'Planos esperando sua aprovação',
    status: `🟡 ${plans.length} plano${plans.length > 1 ? 's' : ''} esperando há mais de um dia`,
    lines: plans.slice(0, 3).map((p) => `${p.title} · ${p.item_count - p.skip_count} itens`),
    details: plans.map((p) => `${p.title} · ${p.item_count - p.skip_count} itens`),
    context: `Reminder about plans pending approval: ${plans.map((p) => `${p.title} (plan ${p.id}, conversation ${p.conversation_id})`).join('; ')}. Approval happens in each plan's own thread or in the web app; here, answer questions about them.`,
  });
  await setState(ctx.db, 'last_pending_reminder', { day: key, plans: plans.map((p) => p.id) });
}
