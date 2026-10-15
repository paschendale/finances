import type { AppContext } from '../context.js';
import { many } from '../db/client.js';
import { getState, setState } from '../db/repo/misc.js';
import { listPlans } from '../db/repo/plans.js';
import { scoped } from '../log.js';

const log = scoped('jobs.nudges');

export interface StaleAccount {
  account_id: string;
  account_name: string;
  account_type: string;
  balance: number;
  last_entry_date: string | null;
  last_checked: string | null;
  days_since_check: number | null;
}

export async function findStaleAccounts(ctx: AppContext): Promise<StaleAccount[]> {
  return many<StaleAccount>(
    ctx.db,
    `SELECT ab.account_id, ab.account_name, ab.account_type, ab.balance, ab.last_entry_date, ab.last_checked,
            CASE WHEN ab.last_checked IS NULL THEN NULL ELSE (CURRENT_DATE - ab.last_checked::date) END AS days_since_check
     FROM account_balances ab
     WHERE ab.account_type IN ('asset','liability') AND ab.hidden = false AND ab.parent_id IS NULL
       AND (ab.last_checked IS NULL OR ab.last_checked < now() - ($1 || ' days')::interval)
       AND ab.last_entry_date IS NOT NULL
     ORDER BY ab.last_checked NULLS FIRST, ab.account_name`,
    [String(ctx.config.STALE_DAYS)],
  );
}

function todayKey(tz: string): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz });
}

const fmt = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);

/** Posts at most once per day, only when at least one account is stale. No Claude call needed. */
export async function staleAccountsJob(ctx: AppContext): Promise<void> {
  const key = todayKey(ctx.config.TZ);
  const last = await getState<{ day: string }>(ctx.db, 'last_stale_nudge');
  if (last?.day === key) return;
  const stale = await findStaleAccounts(ctx);
  if (stale.length === 0) return;
  const moved = stale.filter((a) => a.last_checked && a.last_entry_date && a.last_entry_date > a.last_checked.slice(0, 10));
  const details = stale.map(
    (a) => `${a.account_name} · ${fmt(Number(a.balance))} · ${a.last_checked ? `conferida há ${a.days_since_check} dias` : 'nunca conferida'}${moved.includes(a) ? ' · teve movimento depois' : ''}`,
  );
  await ctx.notifier.notice({
    key: 'stale-accounts',
    title: 'Contas para conferir',
    status: `🔔 ${stale.length} conta${stale.length > 1 ? 's' : ''} sem conferência há mais de ${ctx.config.STALE_DAYS} dias`,
    lines: moved.length ? [`${moved.length} tiveram movimento depois da última conferência: ${moved.slice(0, 3).map((a) => a.account_name).join(', ')}${moved.length > 3 ? '…' : ''}`] : [],
    details: [...details, '', 'Para conferir, responda aqui com o saldo que aparece no banco ("Nubank tá com 657,21"), ou "sem movimento" se nada mudou, ou mande o extrato.'],
    context: `Daily stale-accounts nudge. Accounts without a balance check for more than ${ctx.config.STALE_DAYS} days: ${stale.map((a) => `${a.account_name} (${a.account_id}, balance ${a.balance}, last_checked ${a.last_checked ?? 'never'}, last entry ${a.last_entry_date})`).join('; ')}. The person replies with balances or "sem movimento"; follow the check-in procedure.`,
  });
  await setState(ctx.db, 'last_stale_nudge', { day: key, accounts: stale.map((a) => a.account_id) });
  log.info({ count: stale.length }, 'stale accounts nudge posted');
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
