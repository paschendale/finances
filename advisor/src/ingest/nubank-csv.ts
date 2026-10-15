import { parseCsv } from './csv.js';
import { descriptionHint, detectInstallment, lineHash, round2, type ParsedStatement } from './normalize.js';
import type { StatementLine } from '../db/types.js';

const PT_MONTHS: Record<string, string> = {
  JAN: '01',
  FEV: '02',
  MAR: '03',
  ABR: '04',
  MAI: '05',
  JUN: '06',
  JUL: '07',
  AGO: '08',
  SET: '09',
  OUT: '10',
  NOV: '11',
  DEZ: '12',
};

/** `DDMMMYYYY` with Portuguese month abbreviation → `YYYY-MM-DD`. */
export function parsePtCompactDate(s: string): string | null {
  const m = s.toUpperCase().match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const mm = PT_MONTHS[m[2]!];
  return mm ? `${m[3]}-${mm}-${m[1]}` : null;
}

/** `NU_<acctid>_<DDMMMYYYY>_<DDMMMYYYY>.ext` → account_ref and period. */
export function parseNubankAccountFilename(filename: string): { account_ref: string | null; period_start: string | null; period_end: string | null } {
  const m = filename.match(/NU_(\d+)_(\d{2}[A-Za-z]{3}\d{4})_(\d{2}[A-Za-z]{3}\d{4})/);
  if (!m) return { account_ref: null, period_start: null, period_end: null };
  return { account_ref: m[1]!, period_start: parsePtCompactDate(m[2]!), period_end: parsePtCompactDate(m[3]!) };
}

function brDate(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function isoDate(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null;
}

function num(s: string): number | null {
  let t = s.trim().replace(/[R$\s]/g, '');
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? round2(n) : null;
}

function norm(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Nubank CSV exports.
 *  - Account extract (`Data,Valor,Identificador,Descrição`): Valor already carries the sign
 *    of the money movement on the checking account (negative = out).
 *  - Card bill (`date,title,amount`): `amount` is positive for a charge. The ledger books a card
 *    as a liability where a purchase is a NEGATIVE entry (value flowing out of the card account to
 *    an expense) and a bill payment/refund is POSITIVE, so charges are negated here and
 *    "Pagamento recebido"/refund lines (negative in the file) become positive.
 */
export function parseNubankCsv(text: string, filename: string): ParsedStatement {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  if (rows.length === 0) {
    return { institution: 'nubank', kind: 'other', account_ref: null, currency: 'BRL', period_start: null, period_end: null, opening_balance: null, closing_balance: null, lines: [], warnings: ['empty CSV'] };
  }
  const header = rows[0]!.map(norm);
  const seen = new Map<string, number>();
  const lines: StatementLine[] = [];

  const push = (date: string, amount: number, raw: string, fitid: string | undefined, account: string | null) => {
    let hash = lineHash({ date, amount, raw, fitid, account: account ?? undefined });
    const dup = seen.get(hash) ?? 0;
    seen.set(hash, dup + 1);
    if (dup > 0) hash = lineHash({ date, amount, raw: `${raw}#dup${dup}`, account: account ?? undefined });
    const line: StatementLine = { hash, date, amount, currency: 'BRL', raw, description_hint: descriptionHint(raw), kind: amount < 0 ? 'debit' : 'credit' };
    if (fitid) line.fitid = fitid;
    const inst = detectInstallment(raw);
    if (inst) line.installment = inst;
    lines.push(line);
  };

  if (header[0] === 'data' && header[1] === 'valor') {
    const idIdx = header.indexOf('identificador');
    const descIdx = header.indexOf('descricao');
    const meta = parseNubankAccountFilename(filename);
    for (const r of rows.slice(1)) {
      const date = brDate(r[0] ?? '');
      const amount = num(r[1] ?? '');
      if (!date || amount === null) {
        warnings.push(`skipped row: ${r.join(',').slice(0, 60)}`);
        continue;
      }
      const fitid = idIdx >= 0 ? (r[idIdx] ?? '').trim() || undefined : undefined;
      const raw = (descIdx >= 0 ? r[descIdx] : r[3]) ?? '';
      push(date, amount, raw.trim(), fitid, meta.account_ref);
    }
    lines.sort((a, b) => a.date.localeCompare(b.date));
    return {
      institution: 'nubank',
      kind: 'account',
      account_ref: meta.account_ref,
      currency: 'BRL',
      period_start: meta.period_start ?? lines[0]?.date ?? null,
      period_end: meta.period_end ?? lines[lines.length - 1]?.date ?? null,
      opening_balance: null,
      closing_balance: null,
      lines,
      warnings,
    };
  }

  if (header[0] === 'date' && header.includes('title') && header.includes('amount')) {
    const titleIdx = header.indexOf('title');
    const amountIdx = header.indexOf('amount');
    const billDate = filename.match(/Nubank_(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    for (const r of rows.slice(1)) {
      const date = isoDate(r[0] ?? '');
      const fileAmount = num(r[amountIdx] ?? '');
      if (!date || fileAmount === null) {
        warnings.push(`skipped row: ${r.join(',').slice(0, 60)}`);
        continue;
      }
      const raw = ((titleIdx >= 0 ? r[titleIdx] : r[1]) ?? '').trim();
      push(date, round2(-fileAmount), raw, undefined, null);
    }
    lines.sort((a, b) => a.date.localeCompare(b.date));
    return {
      institution: 'nubank',
      kind: 'card',
      account_ref: null,
      currency: 'BRL',
      period_start: null,
      period_end: billDate ?? lines[lines.length - 1]?.date ?? null,
      opening_balance: null,
      closing_balance: null,
      lines,
      warnings,
    };
  }

  return {
    institution: null,
    kind: 'other',
    account_ref: null,
    currency: 'BRL',
    period_start: null,
    period_end: null,
    opening_balance: null,
    closing_balance: null,
    lines: [],
    warnings: [`unrecognised CSV header: ${rows[0]!.join(',')}`],
  };
}
