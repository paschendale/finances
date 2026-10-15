import { descriptionHint, detectInstallment, lineHash, round2, type ParsedStatement } from './normalize.js';
import type { StatementLine } from '../db/types.js';

/** Decode an OFX file honouring its header (CHARSET:1252 → latin1, else UTF-8). */
export function decodeOfxBuffer(buf: Buffer): string {
  const head = buf.subarray(0, Math.min(buf.length, 2048)).toString('latin1');
  const charset = head.match(/CHARSET:\s*([\w-]+)/i)?.[1]?.toLowerCase();
  const encoding = head.match(/ENCODING:\s*([\w-]+)/i)?.[1]?.toLowerCase();
  const xmlEnc = head.match(/encoding="([^"]+)"/i)?.[1]?.toLowerCase();
  const latin = charset === '1252' || charset === 'iso-8859-1' || charset === 'latin1' || xmlEnc === 'iso-8859-1' || xmlEnc === 'windows-1252';
  if (latin) return buf.toString('latin1');
  if (encoding === 'utf-8' || xmlEnc === 'utf-8' || !charset) {
    // Fall back to latin1 if the bytes are not valid UTF-8.
    const utf = buf.toString('utf8');
    return utf.includes('�') ? buf.toString('latin1') : utf;
  }
  return buf.toString('utf8');
}

interface Node {
  name: string;
  value: string;
  children: Node[];
}

const LEAF_CLOSERS = /<\/[A-Za-z0-9_.]+>\s*$/;

/** Tolerant tokenizer for both SGML (unclosed leaves) and XML OFX bodies. */
function parseBody(body: string): Node {
  const root: Node = { name: 'ROOT', value: '', children: [] };
  const stack: Node[] = [root];
  const re = /<(\/?)([A-Za-z0-9_.]+)>([^<]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const closing = m[1] === '/';
    const name = m[2]!.toUpperCase();
    const text = decodeEntities((m[3] ?? '').trim());
    if (closing) {
      // pop to the matching aggregate (leaves never get pushed)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const parent = stack[stack.length - 1]!;
    if (text !== '') {
      parent.children.push({ name, value: text.replace(LEAF_CLOSERS, '').trim(), children: [] });
    } else {
      const node: Node = { name, value: '', children: [] };
      parent.children.push(node);
      stack.push(node);
    }
  }
  return root;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function find(node: Node, name: string): Node | undefined {
  if (node.name === name) return node;
  for (const c of node.children) {
    const r = find(c, name);
    if (r) return r;
  }
  return undefined;
}

function findAll(node: Node, name: string, out: Node[] = []): Node[] {
  if (node.name === name) out.push(node);
  for (const c of node.children) findAll(c, name, out);
  return out;
}

function leaf(node: Node | undefined, name: string): string | null {
  if (!node) return null;
  const c = node.children.find((x) => x.name === name);
  return c ? c.value : null;
}

/** OFX date: YYYYMMDD[HHMMSS[.XXX]][[+-]TZ[:NAME]] → { date, posted_at } in the statement's own offset. */
export function parseOfxDate(s: string | null): { date: string | null; posted_at: string | null } {
  if (!s) return { date: null, posted_at: null };
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.\d{1,3})?)?(?:\[([+-]?\d{1,2}(?:\.\d+)?)(?::\w+)?\])?/);
  if (!m) return { date: null, posted_at: null };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { date, posted_at: null };
  let offset = 'Z';
  if (m[7] !== undefined) {
    const tz = Number(m[7]);
    const sign = tz < 0 ? '-' : '+';
    const abs = Math.abs(tz);
    const hh = String(Math.floor(abs)).padStart(2, '0');
    const mm = String(Math.round((abs - Math.floor(abs)) * 60)).padStart(2, '0');
    offset = `${sign}${hh}:${mm}`;
  }
  return { date, posted_at: `${date}T${m[4]}:${m[5]}:${m[6]}${offset}` };
}

export function parseOfxAmount(s: string | null): number | null {
  if (s === null) return null;
  let t = s.trim().replace(/\s/g, '');
  if (/,\d{1,2}$/.test(t) && !/\.\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? round2(n) : null;
}

function institutionFrom(org: string | null, fid: string | null): string | null {
  const o = (org ?? '').toLowerCase();
  if (/nu\s*pagamentos|nubank/.test(o) || fid === '260') return 'nubank';
  if (!o) return null;
  return o.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function parseOfx(text: string): ParsedStatement {
  const warnings: string[] = [];
  const bodyStart = text.search(/<OFX>/i);
  const body = bodyStart >= 0 ? text.slice(bodyStart) : text;
  const root = parseBody(body);

  const bankFrom = find(root, 'BANKACCTFROM');
  const ccFrom = find(root, 'CCACCTFROM');
  const kind: ParsedStatement['kind'] = ccFrom ? 'card' : 'account';
  const account_ref = leaf(ccFrom ?? bankFrom, 'ACCTID');
  const currency = (leaf(find(root, 'STMTRS') ?? find(root, 'CCSTMTRS'), 'CURDEF') ?? find(root, 'CURDEF')?.value ?? 'BRL').toUpperCase();
  const fi = find(root, 'FI');
  const institution = institutionFrom(leaf(fi, 'ORG'), leaf(fi, 'FID'));

  const tranList = find(root, 'BANKTRANLIST');
  const period_start = parseOfxDate(leaf(tranList, 'DTSTART')).date;
  let period_end = parseOfxDate(leaf(tranList, 'DTEND')).date;

  const ledgerBal = find(root, 'LEDGERBAL');
  const closing_balance = parseOfxAmount(leaf(ledgerBal, 'BALAMT'));
  const asOf = parseOfxDate(leaf(ledgerBal, 'DTASOF')).date;
  if (!period_end && asOf) period_end = asOf;

  const lines: StatementLine[] = [];
  const seen = new Map<string, number>();
  for (const trn of findAll(root, 'STMTTRN')) {
    const { date, posted_at } = parseOfxDate(leaf(trn, 'DTPOSTED'));
    const amount = parseOfxAmount(leaf(trn, 'TRNAMT'));
    if (!date || amount === null) {
      warnings.push(`skipped STMTTRN without date/amount (FITID ${leaf(trn, 'FITID') ?? '?'})`);
      continue;
    }
    const memo = leaf(trn, 'MEMO');
    const name = leaf(trn, 'NAME');
    const raw = (memo && memo.trim()) || (name && name.trim()) || leaf(trn, 'TRNTYPE') || '';
    const fitid = leaf(trn, 'FITID') ?? undefined;
    let hash = lineHash({ date, amount, raw, fitid, account: account_ref ?? undefined });
    const dup = seen.get(hash) ?? 0;
    seen.set(hash, dup + 1);
    if (dup > 0) hash = lineHash({ date, amount, raw: `${raw}#${dup}`, account: account_ref ?? undefined });
    const line: StatementLine = {
      hash,
      date,
      amount,
      currency,
      raw,
      description_hint: descriptionHint(raw),
      kind: amount < 0 ? 'debit' : 'credit',
    };
    if (posted_at) line.posted_at = posted_at;
    if (fitid) line.fitid = fitid;
    const inst = detectInstallment(raw);
    if (inst) line.installment = inst;
    lines.push(line);
  }
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  const opening_balance = closing_balance === null ? null : round2(closing_balance - total);
  if (closing_balance !== null) {
    let running = closing_balance;
    for (let i = lines.length - 1; i >= 0; i--) {
      lines[i]!.balance_after = round2(running);
      running = round2(running - lines[i]!.amount);
    }
  } else {
    warnings.push('no LEDGERBAL: balances unknown');
  }
  if (!period_start && lines.length) warnings.push('no DTSTART: period_start taken from first line');
  if (lines.length === 0) warnings.push('no STMTTRN found');

  return {
    institution,
    kind,
    account_ref,
    currency,
    period_start: period_start ?? lines[0]?.date ?? null,
    period_end: period_end ?? lines[lines.length - 1]?.date ?? null,
    opening_balance,
    closing_balance,
    lines,
    warnings,
  };
}
