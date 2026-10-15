import { describe, expect, it } from 'vitest';
import { checkReasonLabel, checkStatusLabel, isCheckDue } from './accountCheck';

describe('isCheckDue', () => {
  it('follows the database flag only', () => {
    expect(isCheckDue({ check_due: true })).toBe(true);
    expect(isCheckDue({ check_due: false })).toBe(false);
    expect(isCheckDue({})).toBe(false);
  });
});

describe('checkStatusLabel', () => {
  it('says property and switched-off accounts are never asked about', () => {
    expect(checkStatusLabel({ check_tier: 'never', subtype: 'property' })).toBe('bem sem extrato · não precisa conferir');
    expect(checkStatusLabel({ check_tier: 'never', check_every_days: 0, subtype: 'checking' })).toBe('conferência desligada');
    expect(checkStatusLabel({ check_tier: 'never', subtype: 'checking' })).toBeNull();
  });
  it('explains idle empty accounts', () => {
    expect(checkStatusLabel({ check_tier: 'dormant_empty' })).toBe('parada e zerada · só pede conferência se tiver movimento');
  });
  it('shows the reason when due and the next date otherwise', () => {
    expect(checkStatusLabel({ check_tier: 'occasional', check_due: true, check_reason: 'moved', check_due_on: '2026-10-10' })).toBe('conferir agora · teve movimento depois da última conferência');
    expect(checkStatusLabel({ check_tier: 'active', check_due: false, check_reason: 'cadence', check_due_on: '2026-11-14' })).toBe('próxima conferência em 14/11');
  });
  it('is empty for accounts outside the check (expenses, income)', () => {
    expect(checkStatusLabel({ check_tier: null })).toBeNull();
  });
});

describe('checkReasonLabel', () => {
  it('maps each reason', () => {
    expect(checkReasonLabel({ check_reason: 'never_checked' })).toBe('nunca conferida');
    expect(checkReasonLabel({ check_reason: 'cadence' })).toBe('passou do prazo de conferência');
  });
});
