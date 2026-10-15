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
