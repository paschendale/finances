import { describe, it, expect } from 'vitest';
import { parseQuickEntry } from './parser';

describe('parseQuickEntry', () => {
  it('should parse a simple expense', () => {
    const input = 'padaria 18';
    const result = parseQuickEntry(input);

    expect(result.description).toBe('padaria');
    expect(result.entries).toHaveLength(2);
    expect(result.entries).toContainEqual({ account: 'expenses:unknown', amount: 18 });
    expect(result.entries).toContainEqual({ account: 'assets:unknown', amount: -18 });
  });

  it('should parse an expense with decimal value', () => {
    const input = 'uber 32.50';
    const result = parseQuickEntry(input);

    expect(result.description).toBe('uber');
    expect(result.entries).toContainEqual({ account: 'expenses:unknown', amount: 32.5 });
    expect(result.entries).toContainEqual({ account: 'assets:unknown', amount: -32.5 });
  });

  it('should parse a transfer', () => {
    const input = 'nubank > itau 500';
    const result = parseQuickEntry(input);

    expect(result.description).toBe('Transfer from nubank to itau');
    expect(result.entries).toHaveLength(2);
    expect(result.entries).toContainEqual({ account: 'assets:nubank', amount: -500 });
    expect(result.entries).toContainEqual({ account: 'assets:itau', amount: 500 });
  });

  it('should parse a transfer with decimals', () => {
    const input = 'nubank > itau 123.45';
    const result = parseQuickEntry(input);

    expect(result.description).toBe('Transfer from nubank to itau');
    expect(result.entries).toContainEqual({ account: 'assets:nubank', amount: -123.45 });
    expect(result.entries).toContainEqual({ account: 'assets:itau', amount: 123.45 });
  });
  
  it('should handle multiple words in description for simple expense', () => {
    const input = 'mercado carrefour 120';
    const result = parseQuickEntry(input);

    expect(result.description).toBe('mercado carrefour');
    expect(result.entries).toContainEqual({ account: 'expenses:unknown', amount: 120 });
  });

  it('should parse an income as a reverse transfer', () => {
    const input = 'itau < salary 5000';
    const result = parseQuickEntry(input);

    expect(result.description).toBe('Income from salary to itau');
    expect(result.entries).toHaveLength(2);
    expect(result.entries).toContainEqual({ account: 'assets:itau', amount: 5000 });
    expect(result.entries).toContainEqual({ account: 'income:salary', amount: -5000 });
  });

  it('should handle date in the input (optional)', () => {
    // maybe "2026-03-01 padaria 18"
    const input = '2026-03-01 padaria 18';
    const result = parseQuickEntry(input);

    expect(result.date).toBe('2026-03-01');
    expect(result.description).toBe('padaria');
    expect(result.entries).toContainEqual({ account: 'expenses:unknown', amount: 18 });
  });

  it('should handle comma as decimal separator', () => {
    const input = 'padaria 18,50';
    const result = parseQuickEntry(input);

    expect(result.entries).toContainEqual({ account: 'expenses:unknown', amount: 18.5 });
  });
});
