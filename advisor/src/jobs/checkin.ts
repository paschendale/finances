/**
 * Casual balance check-in detection ("Nubank tá com 657,21"). The daemon only detects the
 * intent and hands the session a precise instruction; the advisor does the resolution and
 * arithmetic with tools (docs/ADVISOR.md §8).
 */
export interface CheckinIntent {
  accountHint: string;
  amount: number;
}

const AMOUNT_RE = /(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|-?\d+(?:[.,]\d{1,2})?)/;

export function parseBrazilianAmount(s: string): number | null {
  const t = s.trim().replace(/^R\$\s*/, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d+,\d{1,2}$/.test(t)) return Number(t.replace(',', '.'));
  if (/^-?\d+(\.\d{1,2})?$/.test(t)) return Number(t);
  return null;
}

export function detectCheckin(text: string): CheckinIntent | null {
  const t = text.trim();
  if (t.length > 120 || t.split('\n').length > 2) return null;
  const m = t.match(new RegExp(`^(?:o\\s+|a\\s+)?(.+?)\\s+(?:t[áa]|est[áa]|tem|fechou|ficou|=|:)\\s*(?:com\\s+|em\\s+)?${AMOUNT_RE.source}\\s*$`, 'i'));
  if (!m) return null;
  const amount = parseBrazilianAmount(m[2]!);
  if (amount === null) return null;
  const hint = m[1]!.replace(/\b(saldo|conta|cart[ãa]o|do|da|de|no|na)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!hint) return null;
  return { accountHint: hint, amount };
}

export function checkinInstruction(i: CheckinIntent): string {
  return [
    `[check-in] The user states that account "${i.accountHint}" currently has balance ${i.amount}.`,
    'Resolve the account with match_account (ask if ambiguous), compute the ledger balance as of today (ledger_balance_as_of / list_account_balances),',
    'reply with the gap, reconciled_through, and the shortest statement period that would cover the gap. On a zero gap, propose mark_checked via a plan.',
    'Never propose an adjustment from a stated balance alone.',
  ].join(' ');
}
