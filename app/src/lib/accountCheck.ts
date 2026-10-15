/**
 * Balance-check cadence. The database decides when an account is due (view account_check_status,
 * migration 0057, exposed as trailing columns of account_balances); this module only reads it.
 */

export type CheckTier = 'never' | 'fixed' | 'active' | 'occasional' | 'dormant' | 'dormant_empty';
export type CheckReason = 'never_checked' | 'moved' | 'cadence';

export interface CheckFields {
  subtype?: string | null;
  check_every_days?: number | null;
  check_tier?: CheckTier | null;
  check_due_on?: string | null;
  check_due?: boolean | null;
  check_reason?: CheckReason | null;
}

export const isCheckDue = (a: CheckFields): boolean => a.check_due === true;

/** Values for accounts.check_every_days: null = automatic, 0 = never. */
export const CHECK_CADENCE_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: null, label: 'Automático' },
  { value: 30, label: '30 dias' },
  { value: 90, label: '90 dias' },
  { value: 180, label: '6 meses' },
  { value: 0, label: 'Nunca' },
];

const dayMonth = (d: string) => {
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
};

/** Why a due account is due, in everyday Portuguese. */
export function checkReasonLabel(a: CheckFields): string {
  if (a.check_reason === 'never_checked') return 'nunca conferida';
  if (a.check_reason === 'moved') return 'teve movimento depois da última conferência';
  return 'passou do prazo de conferência';
}

/** One line for an account card: when it will be asked about, or why it never is. */
export function checkStatusLabel(a: CheckFields): string | null {
  switch (a.check_tier) {
    case null:
    case undefined:
      return null;
    case 'never':
      if (a.check_every_days === 0) return 'conferência desligada';
      if (a.subtype === 'property') return 'bem sem extrato · não precisa conferir';
      return null;
    case 'dormant_empty':
      return 'parada e zerada · só pede conferência se tiver movimento';
    default:
      if (isCheckDue(a)) return `conferir agora · ${checkReasonLabel(a)}`;
      return a.check_due_on ? `próxima conferência em ${dayMonth(a.check_due_on)}` : null;
  }
}
