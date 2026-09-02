import { describe, expect, it } from 'vitest';
import { AuthError, PostgrestApiError, formatToolError } from './errors';

describe('formatToolError', () => {
  it('renders a PostgrestApiError message plus hint and details when present', () => {
    const err = new PostgrestApiError('P0001', 'Transaction is not balanced: SUM(amount_base) = 50.00', 'some details', 'some hint', 400);
    const text = formatToolError(err);
    expect(text).toContain('Transaction is not balanced: SUM(amount_base) = 50.00');
    expect(text).toContain('Hint: some hint');
    expect(text).toContain('Details: some details');
  });

  it('renders just the message when hint/details are absent', () => {
    const err = new PostgrestApiError(null, 'boom', null, null, 500);
    expect(formatToolError(err)).toBe('boom');
  });

  it('prefixes AuthError with an authentication-specific message', () => {
    expect(formatToolError(new AuthError('Invalid or revoked access token'))).toBe(
      'Authentication failed: Invalid or revoked access token'
    );
  });

  it('falls back to String() for non-Error values', () => {
    expect(formatToolError('plain string failure')).toBe('plain string failure');
  });
});
