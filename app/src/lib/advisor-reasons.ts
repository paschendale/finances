import type { Account, DashboardEntry } from '@/lib/api';

const STALE_DAYS = 30;
const UNCATEGORISED = 'sem-categoria';

export interface AdvisorReason {
  key: 'moved' | 'stale' | 'uncategorised';
  label: string;
  detail: string;
  message: string;
  context: string;
  title: string;
}

const fmt = (n: number) => `R$ ${Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysSince = (iso: string | null, now: Date) => (iso ? Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000) : null);

/** What the advisor could do right now, derived from the dashboard's own data. Empty when nothing is pressing. */
export function advisorReasons(accounts: Account[], entries: DashboardEntry[], range: { start: string; end: string }, now = new Date()): AdvisorReason[] {
  const reasons: AdvisorReason[] = [];
  const balanceAccounts = accounts.filter((a) => !a.hidden && !a.parent_id && (a.account_type === 'asset' || a.account_type === 'liability'));

  // Accounts that moved after their last balance check (or were never checked)
  const moved = balanceAccounts.filter((a) => a.last_entry_date && (!a.last_checked || a.last_entry_date > a.last_checked.slice(0, 10)));
  if (moved.length > 0) {
    reasons.push({
      key: 'moved',
      label: moved.length === 1 ? '1 conta com movimento sem conferência' : `${moved.length} contas com movimento sem conferência`,
      detail: moved.slice(0, 3).map((a) => a.account_name).join(', ') + (moved.length > 3 ? '…' : ''),
      title: 'Conferência de saldos',
      message: 'Quero conferir os saldos das contas que tiveram movimento depois da última conferência.',
      context: `Accounts with entries after their last balance check: ${moved.map((a) => `${a.account_name} (id ${a.account_id}, ledger balance ${a.balance}, last entry ${a.last_entry_date}, last checked ${a.last_checked ?? 'never'})`).join('; ')}. Ask for current balances or statements and run the check-in procedure.`,
    });
  }

  // Accounts not checked for a long time
  const stale = balanceAccounts.filter((a) => !moved.includes(a) && a.last_entry_date && (daysSince(a.last_checked, now) ?? Infinity) >= STALE_DAYS);
  if (stale.length > 0) {
    reasons.push({
      key: 'stale',
      label: stale.length === 1 ? `1 conta sem conferência há ${STALE_DAYS}+ dias` : `${stale.length} contas sem conferência há ${STALE_DAYS}+ dias`,
      detail: stale.slice(0, 3).map((a) => a.account_name).join(', ') + (stale.length > 3 ? '…' : ''),
      title: 'Conferência de saldos',
      message: `Quais contas estão sem conferência há mais de ${STALE_DAYS} dias? Vamos conferir.`,
      context: `Accounts without a balance check for ${STALE_DAYS}+ days: ${stale.map((a) => `${a.account_name} (id ${a.account_id}, ledger balance ${a.balance}, last checked ${a.last_checked ?? 'never'})`).join('; ')}. Ask for current balances ("sem movimento" marks an account checked) and run the check-in procedure.`,
    });
  }

  // Uncategorised entries in the selected range
  const unc = entries.filter((e) => e.account_type === 'expense' && (e.account_name === UNCATEGORISED || e.account_name.startsWith(`${UNCATEGORISED}:`)));
  if (unc.length > 0) {
    const total = unc.reduce((s, e) => s + e.amount_base, 0);
    reasons.push({
      key: 'uncategorised',
      label: unc.length === 1 ? '1 lançamento sem categoria' : `${unc.length} lançamentos sem categoria`,
      detail: `${fmt(total)} entre ${range.start} e ${range.end}`,
      title: 'Lançamentos sem categoria',
      message: `Me ajude a categorizar os lançamentos em ${UNCATEGORISED} de ${range.start} a ${range.end}.`,
      context: `There are ${unc.length} entries on ${UNCATEGORISED} between ${range.start} and ${range.end} totalling ${total.toFixed(2)}. List them with list_transactions, propose categories with classify_candidates and draft update items in one plan; ask about the ones you cannot place.`,
    });
  }

  return reasons;
}
