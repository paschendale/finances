import { createHash } from 'node:crypto';
import type { StatementLine } from '../db/types.js';

/** Parsed statement, independent of the source format (OFX, CSV, PDF). */
export interface ParsedStatement {
  institution: string | null;
  kind: 'account' | 'card' | 'investment' | 'other';
  /** Bank-side account identifier (OFX ACCTID, Nubank filename acctid), used to map to a ledger account. */
  account_ref: string | null;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  lines: StatementLine[];
  warnings: string[];
}

/** Stable identity of a statement line; FITID wins when the bank provides one. */
export function lineHash(input: { date: string; amount: number; raw: string; fitid?: string; account?: string }): string {
  const parts = input.fitid
    ? ['fitid', input.account ?? '', input.fitid]
    : ['line', input.account ?? '', input.date, input.amount.toFixed(2), input.raw.trim().replace(/\s+/g, ' ')];
  return createHash('sha256').update(parts.join('\u0001')).digest('hex');
}

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * JS port of the SQL `normalize_merchant` (migrations/0050_derived_classification.sql).
 * Keep the two in sync; the SQL version is authoritative for classification, this one only
 * produces `description_hint`.
 */
export function normalizeMerchantJs(raw: string): string {
  let s = stripAccents(raw).toLowerCase();
  s = s.replace(/\s+/g, ' ').trim();
  // processor / bank prefixes
  s = s.replace(/^(transferencia (enviada|recebida) pelo pix\s*-?\s*)/g, '');
  s = s.replace(/^(compra no (debito|credito)\s*-?\s*)/g, '');
  s = s.replace(/^(pagamento (de )?(boleto|fatura)\s*-?\s*)/g, '');
  s = s.replace(/^(pg\s*\*|pag\s*\*|mp\s*\*|mercadopago\s*\*|ifd\s*\*|uber\s*\*|ebn\s*\*|dl\s*\*|zul\s*\*|rec\s*\*|pix\s+)\s*/g, '');
  s = s.replace(/^(cielo|rede|getnet|stone|pagseguro|picpay)\s*\*\s*/g, '');
  // installment markers: 3/6, 03/06, (3 de 6), parcela 3/6
  s = s.replace(/\(?\bparcela\s*\d{1,2}\s*(\/|de)\s*\d{1,2}\)?/g, ' ');
  s = s.replace(/\(\s*\d{1,2}\s*de\s*\d{1,2}\s*\)/g, ' ');
  s = s.replace(/\b\d{1,2}\s*\/\s*\d{1,2}\b/g, ' ');
  // legal suffixes
  s = s.replace(/\b(ltda|me|epp|eireli|s\.?\/?a\.?|sa|ltda\.?|cia)\b\.?/g, ' ');
  // trailing UF code (optionally preceded by a dash)
  s = s.replace(/\s*-?\s+\b(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)\b\s*$/g, ' ');
  // trailing digits / codes
  s = s.replace(/(\s+\d+)+\s*$/g, ' ');
  s = s.replace(/[^a-z0-9 ]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

const SMALL_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'the', 'of', 'and', 'com', 'para']);

export function titleCase(s: string): string {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function descriptionHint(raw: string): string {
  const hint = titleCase(normalizeMerchantJs(raw));
  return hint || raw.trim();
}

export function detectInstallment(raw: string): { current: number; total: number } | null {
  const m = raw.match(/\(\s*(\d{1,2})\s*de\s*(\d{1,2})\s*\)/i) ?? raw.match(/parcela\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})/i) ?? raw.match(/(?:^|\s|-)(\d{1,2})\s*\/\s*(\d{1,2})(?=\s|$)/);
  if (!m) return null;
  const current = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || current < 1 || total < 1 || current > total) return null;
  return { current, total };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  'hash',
  'date',
  'posted_at',
  'amount',
  'currency',
  'kind',
  'raw',
  'description_hint',
  'fitid',
  'balance_after',
  'already_in_ledger',
  'likely_duplicate',
  'alias',
  'top_candidate',
  'confidence',
] as const;

/** Normalized lines as CSV for the session workspace (RFC 4180). */
export function toCsv(lines: StatementLine[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const l of lines) {
    const top = l.candidates?.[0];
    rows.push(
      [
        l.hash,
        l.date,
        l.posted_at ?? '',
        l.amount,
        l.currency,
        l.kind,
        l.raw,
        l.description_hint,
        l.fitid ?? '',
        l.balance_after ?? '',
        l.already_in_ledger ? 'true' : 'false',
        l.likely_duplicate ? 'true' : 'false',
        l.alias?.canonical_description ?? '',
        top?.category_name ?? '',
        top ? top.confidence : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return rows.join('\r\n') + '\r\n';
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
