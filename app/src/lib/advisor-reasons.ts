import type { Account, DashboardEntry } from '@/lib/api';
import { isCheckDue } from '@/lib/accountCheck';

const UNCATEGORISED = 'sem-categoria';

export interface AdvisorReason {
  key: 'check' | 'uncategorised';
  label: string;
  detail: string;
  message: string;
  context: string;
  title: string;
}

const fmt = (n: number) => `R$ ${Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the advisor could do right now, derived from the dashboard's own data. Empty when nothing is pressing. */
export function advisorReasons(accounts: Account[], entries: DashboardEntry[], range: { start: string; end: string }): AdvisorReason[] {
  const reasons: AdvisorReason[] = [];
  const balanceAccounts = accounts.filter((a) => !a.hidden && !a.parent_id && (a.account_type === 'asset' || a.account_type === 'liability'));

  // Accounts due for a balance check; the database decides (account_check_status, migration 0057).
  const due = balanceAccounts.filter(isCheckDue);
  if (due.length > 0) {
    reasons.push({
      key: 'check',
      label: due.length === 1 ? '1 conta para conferir' : `${due.length} contas para conferir`,
      detail: due.slice(0, 3).map((a) => a.account_name).join(', ') + (due.length > 3 ? '…' : ''),
      title: 'Conferência de saldos',
      message: due.length === 1 ? `Quero conferir o saldo de ${due[0].account_name}.` : 'Quero conferir os saldos das contas que estão para conferir.',
      context: `Accounts due for a balance check: ${due.map((a) => `${a.account_name} (id ${a.account_id}, ledger balance ${a.balance}, last entry ${a.last_entry_date ?? 'none'}, last checked ${a.last_checked ?? 'never'}, why: ${a.check_reason ?? 'unknown'})`).join('; ')}. Ask for current balances or statements ("sem movimento" marks an account checked) and run the check-in procedure.`,
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
