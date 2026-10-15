import { execFile } from 'node:child_process';
import { descriptionHint, lineHash, round2, type ParsedStatement } from './normalize.js';
import type { StatementLine } from '../db/types.js';

/** `pdftotext -layout <file> -` (poppler). Fallback path: OFX/CSV are preferred when available. */
export function pdfToText(filePath: string, bin = 'pdftotext'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-layout', '-enc', 'UTF-8', filePath, '-'], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return reject(new Error(`pdftotext not found (install poppler-utils); cannot read ${filePath}`));
        return reject(new Error(`pdftotext failed: ${e.message} ${String(stderr).slice(0, 200)}`));
      }
      resolve(String(stdout));
    });
  });
}

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

function brl(s: string): number | null {
  const m = s.replace(/\s/g, '').match(/^(-)?R?\$?(-)?([\d.]+),(\d{2})$/);
  if (!m) return null;
  const n = Number(`${m[3]!.replace(/\./g, '')}.${m[4]}`);
  if (!Number.isFinite(n)) return null;
  return m[1] || m[2] ? -n : n;
}

const OUT_WORDS = /transfer[eê]ncia enviada|pagamento|compra|d[eé]bito|saque|tarifa|boleto/i;

/**
 * Best-effort reader for the Nubank account statement PDF text. Looks for day headers
 * (`DD MMM YYYY`) followed by movement lines ending in `R$ 1.234,56`, plus `Saldo inicial/final`.
 */
export function parseNubankPdfText(text: string): ParsedStatement {
  const warnings: string[] = ['pdf parser is best-effort; prefer the OFX or CSV attachment'];
  const lines: StatementLine[] = [];
  let currentDate: string | null = null;
  let opening: number | null = null;
  let closing: number | null = null;
  const seen = new Map<string, number>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const dh = line.match(/^(\d{2})\s+([A-Za-zÇç]{3})\s+(\d{4})\b/);
    if (dh) {
      const mm = PT_MONTHS[dh[2]!.toUpperCase()];
      if (mm) currentDate = `${dh[3]}-${mm}-${dh[1]}`;
      continue;
    }
    const bal = line.match(/^saldo\s+(inicial|final|anterior)\b.*?(-?\s*R\$\s*-?[\d.]+,\d{2})/i);
    if (bal) {
      const v = brl(bal[2]!);
      if (v !== null) {
        if (/inicial|anterior/i.test(bal[1]!)) opening = v;
        else closing = v;
      }
      continue;
    }
    if (!currentDate) continue;
    const mv = line.match(/^(.*?)\s{2,}(-?\s*R\$\s*-?[\d.]+,\d{2})\s*$/) ?? line.match(/^(.*?)\s+(-?\s*R\$\s*-?[\d.]+,\d{2})\s*$/);
    if (!mv) continue;
    const desc = mv[1]!.trim();
    let amount = brl(mv[2]!);
    if (amount === null || !desc) continue;
    if (amount > 0 && OUT_WORDS.test(desc) && !/recebid|estorno|reembolso|rendimento|dep[oó]sito/i.test(desc)) amount = -amount;
    amount = round2(amount);
    let hash = lineHash({ date: currentDate, amount, raw: desc });
    const dup = seen.get(hash) ?? 0;
    seen.set(hash, dup + 1);
    if (dup > 0) hash = lineHash({ date: currentDate, amount, raw: `${desc}#dup${dup}` });
    lines.push({ hash, date: currentDate, amount, currency: 'BRL', raw: desc, description_hint: descriptionHint(desc), kind: amount < 0 ? 'debit' : 'credit' });
  }
  if (lines.length === 0) warnings.push('no movements recognised in PDF text');
  lines.sort((a, b) => a.date.localeCompare(b.date));
  if (closing !== null) {
    let running = closing;
    for (let i = lines.length - 1; i >= 0; i--) {
      lines[i]!.balance_after = round2(running);
      running = round2(running - lines[i]!.amount);
    }
  }
  return {
    institution: /nubank|nu pagamentos/i.test(text) ? 'nubank' : null,
    kind: 'account',
    account_ref: text.match(/Conta:?\s*(\d{4,})/i)?.[1] ?? null,
    currency: 'BRL',
    period_start: lines[0]?.date ?? null,
    period_end: lines[lines.length - 1]?.date ?? null,
    opening_balance: opening ?? (closing !== null ? round2(closing - lines.reduce((s, l) => s + l.amount, 0)) : null),
    closing_balance: closing,
    lines,
    warnings,
  };
}

const ITAU_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const isoFromBr = (d: string): string => {
  const m = ITAU_DATE.exec(d)!;
  return `${m[3]}-${m[2]}-${m[1]}`;
};

/**
 * Itaú current-account PDF ("extrato conta / lançamentos"): rows `dd/mm/yyyy DESCRIPTION amount`,
 * newest first, with a `SALDO DO DIA` row per day holding the day's closing balance. The row for the
 * day before the first movement carries the opening balance; the header gives the period and the
 * agency/account numbers.
 */
export function parseItauPdfText(text: string): ParsedStatement {
  const warnings: string[] = [];
  const lines: StatementLine[] = [];
  const dayBalance = new Map<string, number>();
  const seen = new Map<string, number>();
  const period = text.match(/per[ií]odo de visualiza[çc][ãa]o:\s*(\d{2}\/\d{2}\/\d{4})\s+at[ée]\s+(\d{2}\/\d{2}\/\d{4})/i);
  const acct = text.match(/ag[êe]ncia:\s*(\d+)\s+conta:\s*([\d-]+)/i);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s{2,}(-?[\d.]+,\d{2})\s*$/) ?? line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(-?[\d.]+,\d{2})\s*$/);
    if (!m) continue;
    const date = isoFromBr(m[1]!);
    const desc = m[2]!.trim();
    const value = brl(m[3]!);
    if (value === null || !desc) continue;
    if (/^SALDO\b/i.test(desc)) {
      dayBalance.set(date, value);
      continue;
    }
    const amount = round2(value);
    let hash = lineHash({ date, amount, raw: desc });
    const dup = seen.get(hash) ?? 0;
    seen.set(hash, dup + 1);
    if (dup > 0) hash = lineHash({ date, amount, raw: `${desc}#dup${dup}` });
    lines.push({ hash, date, amount, currency: 'BRL', raw: desc, description_hint: descriptionHint(desc), kind: amount < 0 ? 'debit' : 'credit' });
  }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  if (lines.length === 0) warnings.push('no movements recognised in PDF text');

  const balanceDates = [...dayBalance.keys()].sort();
  const firstMove = lines[0]?.date ?? null;
  const openingDate = firstMove ? balanceDates.filter((d) => d < firstMove).pop() : undefined;
  const closingDate = balanceDates[balanceDates.length - 1];
  const closing = closingDate !== undefined ? dayBalance.get(closingDate)! : null;
  const sum = round2(lines.reduce((acc, l) => acc + l.amount, 0));
  const opening = openingDate !== undefined ? dayBalance.get(openingDate)! : closing !== null ? round2(closing - sum) : null;
  if (opening !== null && closing !== null && Math.abs(round2(opening + sum) - closing) >= 0.005) {
    warnings.push(`day balances do not add up: opening ${opening} + movements ${sum} = ${round2(opening + sum)}, but the last balance printed is ${closing}`);
  }
  if (opening !== null) {
    let running = opening;
    for (const l of lines) {
      running = round2(running + l.amount);
      l.balance_after = running;
    }
  }
  return {
    institution: 'itau',
    kind: 'account',
    account_ref: acct ? `${acct[1]}-${acct[2]}` : null,
    currency: 'BRL',
    period_start: period ? isoFromBr(period[1]!) : (lines[0]?.date ?? null),
    period_end: period ? isoFromBr(period[2]!) : (closingDate ?? lines[lines.length - 1]?.date ?? null),
    opening_balance: opening,
    closing_balance: closing,
    lines,
    warnings,
  };
}

const BRB_ROW = /^(\d{2})\/(\d{2})\b\s*(.*?)\s*R\$\s*([+\-−])?\s*([\d.]+,\d{2})\s*$/;
const BRB_NOISE = /^(Dia\s+Hist[óo]rico\s+Valor|[A-ZÇ]+\/\d{4}|Extrato|\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}|Ag[êe]ncia:.*)$/i;

/** True when the text has the BRB app export's table: `Dia / Histórico / Valor` with signed `R$ ±` values. */
export function looksLikeBrbPdf(text: string): boolean {
  return /Dia\s+Hist[óo]rico\s+Valor/i.test(text) && /Conta Corrente:/i.test(text) && /R\$\s*[+−]\s*[\d.]+,\d{2}/.test(text);
}

/**
 * BRB current-account PDF exported from the app. Rows run newest first and carry no year (`dd/mm`);
 * the year comes from the emission stamp (`dd/mm/yyyy hh:mm`) and steps back whenever the month goes
 * up. Most rows span three lines (history with `– DOC: n`, then date and value, then the counterparty);
 * yield credits fit on one. The DOC number is dropped from `raw` so a payee always reads the same.
 * The export prints no balance, so opening and closing stay null for the person to supply.
 */
export function parseBrbPdfText(text: string): ParsedStatement {
  const warnings: string[] = [];
  const emitted = text.match(/(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}/);
  const acct = text.match(/Ag[êe]ncia:\s*(\d+)\s*\S*\s*Conta Corrente:\s*([\d.\-]+)/i);
  const cleanHistory = (s: string) => s.replace(/\s*[–—-]\s*DOC:\s*\d*\s*$/i, '').replace(/\s+/g, ' ').trim();

  type Row = { day: string; month: number; amount: number; before: string[]; inline: string; after: string[] };
  const rows: Row[] = [];
  let pending: string[] = [];
  let open: Row | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      open = null;
      pending = [];
      continue;
    }
    const m = BRB_ROW.exec(line);
    if (m) {
      const sign = m[4] === '-' || m[4] === '−' ? -1 : 1;
      const value = Number(m[5]!.replace(/\./g, '').replace(',', '.'));
      open = { day: m[1]!, month: Number(m[2]), amount: round2(sign * value), before: pending, inline: m[3]!, after: [] };
      rows.push(open);
      pending = [];
      continue;
    }
    if (BRB_NOISE.test(line)) {
      open = null;
      pending = [];
      continue;
    }
    if (open) open.after.push(line);
    else pending.push(line);
  }

  let year = emitted ? Number(emitted[3]) : null;
  let prevMonth = emitted ? Number(emitted[2]) : null;
  if (year === null) warnings.push('emission date not found; rows have no year');
  const lines: StatementLine[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (year === null) break;
    if (prevMonth !== null && r.month > prevMonth) year -= 1;
    prevMonth = r.month;
    const date = `${year}-${String(r.month).padStart(2, '0')}-${r.day}`;
    const history = cleanHistory([...r.before, r.inline].filter(Boolean).join(' '));
    const counterparty = r.after.join(' ').replace(/\s+/g, ' ').trim();
    const desc = [history, counterparty].filter(Boolean).join(' ');
    if (!desc) continue;
    const name = counterparty.split(/\s+—\s+/)[0]!.trim();
    const hint = /[A-Za-z]/.test(name) ? descriptionHint(counterparty) : descriptionHint(history);
    let hash = lineHash({ date, amount: r.amount, raw: desc });
    const dup = seen.get(hash) ?? 0;
    seen.set(hash, dup + 1);
    if (dup > 0) hash = lineHash({ date, amount: r.amount, raw: `${desc}#dup${dup}` });
    lines.push({ hash, date, amount: r.amount, currency: 'BRL', raw: desc, description_hint: hint, kind: r.amount < 0 ? 'debit' : 'credit' });
  }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  if (lines.length === 0) warnings.push('no movements recognised in PDF text');
  warnings.push('BRB PDF prints no balance; the closing balance must come from the bank app');
  return {
    institution: 'brb',
    kind: 'account',
    account_ref: acct ? `${acct[1]}-${acct[2]}` : null,
    currency: 'BRL',
    period_start: lines[0]?.date ?? null,
    period_end: emitted ? `${emitted[3]}-${emitted[2]}-${emitted[1]}` : (lines[lines.length - 1]?.date ?? null),
    opening_balance: null,
    closing_balance: null,
    lines,
    warnings,
  };
}

/** Picks the PDF reader from the text: Itaú's day-balance layout, BRB's app export, else the Nubank reader. */
export function parsePdfText(text: string): ParsedStatement {
  if (/SALDO DO DIA/.test(text) && /lan[çc]amentos/i.test(text)) return parseItauPdfText(text);
  if (looksLikeBrbPdf(text)) return parseBrbPdfText(text);
  return parseNubankPdfText(text);
}
