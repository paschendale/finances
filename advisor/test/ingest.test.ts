import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { decodeOfxBuffer, parseOfx, parseOfxDate, parseOfxAmount } from '../src/ingest/ofx.js';
import { parseNubankCsv, parseNubankAccountFilename, parsePtCompactDate } from '../src/ingest/nubank-csv.js';
import { parseCsv } from '../src/ingest/csv.js';
import { parseBrbPdfText, parseItauPdfText, parseNubankPdfText, parsePdfText } from '../src/ingest/pdf.js';
import { detectFormat, detectInstitution, parseStatementFile } from '../src/ingest/detect.js';
import { descriptionHint, detectInstallment, lineHash, normalizeMerchantJs, titleCase, toCsv } from '../src/ingest/normalize.js';
import { assignAutoMatches, extractCounterparty, isCardPayment, matchLines, pairTransfers } from '../src/ingest/match.js';
import type { StatementLine } from '../src/db/types.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string) => fs.readFileSync(path.join(fixtures, name));

describe('normalize', () => {
  it('normalizeMerchantJs mirrors the SQL rules', () => {
    expect(normalizeMerchantJs('TAMPOPO ALIMENTOS LTDA')).toBe('tampopo alimentos');
    expect(normalizeMerchantJs('PG *TAMPOPO ALIMENTOS')).toBe('tampopo alimentos');
    expect(normalizeMerchantJs('UBER *TRIP SAO PAULO SP')).toBe('trip sao paulo');
    expect(normalizeMerchantJs('Parcela 3/6 - MAGAZINE LUIZA S/A')).toBe('magazine luiza');
    expect(normalizeMerchantJs('Compra no débito - NETFLIX.COM 3/6')).toBe('netflix com');
    expect(normalizeMerchantJs('IFD*IFOOD 12345')).toBe('ifood');
    expect(normalizeMerchantJs('Transferência enviada pelo Pix - JOAO DA SILVA - 12/09')).toBe('joao da silva');
  });

  it('titleCase and descriptionHint', () => {
    expect(titleCase('tampopo alimentos')).toBe('Tampopo Alimentos');
    expect(titleCase('casa de bolos')).toBe('Casa de Bolos');
    expect(descriptionHint('PG *TAMPOPO ALIMENTOS LTDA')).toBe('Tampopo Alimentos');
    expect(descriptionHint('***')).toBe('***'); // falls back to the raw text when nothing survives
  });

  it('detectInstallment', () => {
    expect(detectInstallment('Loja X - Parcela 2/5')).toEqual({ current: 2, total: 5 });
    expect(detectInstallment('MAGAZINE 03/06')).toEqual({ current: 3, total: 6 });
    expect(detectInstallment('Curso (3 de 6)')).toEqual({ current: 3, total: 6 });
    expect(detectInstallment('Tampopo Alimentos')).toBeNull();
    expect(detectInstallment('Pix 12/09')).toBeNull(); // current > total → not an installment
  });

  it('lineHash is stable and FITID-driven when present', () => {
    const a = lineHash({ date: '2026-10-01', amount: -45.9, raw: 'X', fitid: 'F1' });
    const b = lineHash({ date: '2026-10-02', amount: -1, raw: 'Y', fitid: 'F1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const c = lineHash({ date: '2026-10-01', amount: -45.9, raw: 'X  Y' });
    expect(c).toBe(lineHash({ date: '2026-10-01', amount: -45.9, raw: 'X Y ' }));
    expect(c).not.toBe(lineHash({ date: '2026-10-01', amount: -45.91, raw: 'X Y' }));
  });

  it('toCsv quotes per RFC 4180', () => {
    const line: StatementLine = {
      hash: 'h1',
      date: '2026-10-01',
      amount: -45.9,
      currency: 'BRL',
      raw: 'Netflix.com, "Inc"',
      description_hint: 'Netflix Com',
      kind: 'debit',
      candidates: [{ category_id: 'c', category_name: 'lazer:streaming', score: 1.2, confidence: 0.91 }],
    };
    const csv = toCsv([line]);
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toBe('hash,date,posted_at,amount,currency,kind,raw,description_hint,fitid,balance_after,already_in_ledger,likely_duplicate,alias,top_candidate,confidence');
    expect(rows[1]).toContain('"Netflix.com, ""Inc"""');
    expect(rows[1]).toContain(',-45.90,');
    expect(rows[1]).toContain('lazer:streaming,0.91');
    expect(parseCsv(csv)[1]![6]).toBe('Netflix.com, "Inc"');
  });
});

describe('csv reader', () => {
  it('handles BOM, CRLF, quotes and semicolons', () => {
    expect(parseCsv('﻿a,b\r\n1,"x, y"\r\n')).toEqual([
      ['a', 'b'],
      ['1', 'x, y'],
    ]);
    expect(parseCsv('a;b\n1;2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\n"he said ""hi""",2')).toEqual([
      ['a', 'b'],
      ['he said "hi"', '2'],
    ]);
  });
});

describe('ofx', () => {
  it('decodes latin1 when CHARSET:1252', () => {
    const latin = Buffer.concat([Buffer.from('OFXHEADER:100\nCHARSET:1252\n<OFX><MEMO>caf', 'latin1'), Buffer.from([0xe9]), Buffer.from('</OFX>', 'latin1')]);
    expect(decodeOfxBuffer(latin)).toContain('café');
    const utf = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><OFX><MEMO>café</MEMO></OFX>', 'utf8');
    expect(decodeOfxBuffer(utf)).toContain('café');
  });

  it('parses dates and amounts', () => {
    expect(parseOfxDate('20261001143012[-3:BRT]')).toEqual({ date: '2026-10-01', posted_at: '2026-10-01T14:30:12-03:00' });
    expect(parseOfxDate('20261001')).toEqual({ date: '2026-10-01', posted_at: null });
    expect(parseOfxDate('20261001120000.000[0:GMT]').posted_at).toBe('2026-10-01T12:00:00+00:00');
    expect(parseOfxAmount('-1234.56')).toBe(-1234.56);
    expect(parseOfxAmount('-10,50')).toBe(-10.5);
    expect(parseOfxAmount('1.234,56')).toBe(1234.56);
  });

  it('parses the Nubank SGML fixture', () => {
    const s = parseOfx(decodeOfxBuffer(read('nubank-account.ofx')));
    expect(s.institution).toBe('nubank');
    expect(s.kind).toBe('account');
    expect(s.account_ref).toBe('12345678');
    expect(s.currency).toBe('BRL');
    expect(s.period_start).toBe('2026-10-01');
    expect(s.period_end).toBe('2026-10-11');
    expect(s.closing_balance).toBe(2409.48);
    expect(s.lines).toHaveLength(8);
    expect(s.warnings).toEqual([]);
    const sum = s.lines.reduce((a, l) => a + l.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(1749.48);
    expect(s.opening_balance).toBe(660);
    const first = s.lines[0]!;
    expect(first.date).toBe('2026-10-01');
    expect(first.posted_at).toBe('2026-10-01T14:30:12-03:00');
    expect(first.amount).toBe(-45.9);
    expect(first.kind).toBe('debit');
    expect(first.fitid).toBe('66f1a0000000000000000001');
    expect(first.raw).toBe('Compra no débito - TAMPOPO ALIMENTOS LTDA');
    expect(first.description_hint).toBe('Tampopo Alimentos');
    expect(first.balance_after).toBe(614.1);
    expect(s.lines[2]!.kind).toBe('credit');
    expect(s.lines[7]!.balance_after).toBe(2409.48);
    // balance_after chain: each = previous + amount
    for (let i = 1; i < s.lines.length; i++) {
      expect(Math.round((s.lines[i - 1]!.balance_after! + s.lines[i]!.amount) * 100) / 100).toBe(s.lines[i]!.balance_after);
    }
    expect(s.lines.every((l) => l.hash.length === 64)).toBe(true);
    expect(new Set(s.lines.map((l) => l.hash)).size).toBe(8);
  });

  it('parses the XML variant', () => {
    const s = parseOfx(read('nubank-account-xml.ofx').toString('utf8'));
    expect(s.institution).toBe('nubank');
    expect(s.account_ref).toBe('87654321');
    expect(s.lines).toHaveLength(3);
    expect(s.lines[0]!.amount).toBe(-10.5);
    expect(s.lines[0]!.raw).toBe('Padaria & Cia');
    expect(s.lines[1]!.raw).toContain('Transferência recebida pelo Pix - BELTRANO');
    expect(s.lines[1]!.posted_at).toBe('2026-10-02T12:00:00Z');
    expect(s.closing_balance).toBe(559.5);
    expect(s.opening_balance).toBe(500);
    expect(s.period_start).toBe('2026-10-01');
    expect(s.period_end).toBe('2026-10-03');
  });
});

describe('nubank csv', () => {
  it('filename helpers', () => {
    expect(parsePtCompactDate('01OUT2026')).toBe('2026-10-01');
    expect(parsePtCompactDate('15FEV2025')).toBe('2025-02-15');
    expect(parseNubankAccountFilename('NU_12345678_01OUT2026_11OUT2026.csv')).toEqual({ account_ref: '12345678', period_start: '2026-10-01', period_end: '2026-10-11' });
  });

  it('parses the account extract and agrees with the OFX', () => {
    const s = parseNubankCsv(read('nubank-account.csv').toString('utf8'), 'NU_12345678_01OUT2026_11OUT2026.csv');
    const o = parseOfx(decodeOfxBuffer(read('nubank-account.ofx')));
    expect(s.kind).toBe('account');
    expect(s.institution).toBe('nubank');
    expect(s.account_ref).toBe('12345678');
    expect(s.period_start).toBe('2026-10-01');
    expect(s.period_end).toBe('2026-10-11');
    expect(s.closing_balance).toBeNull();
    expect(s.lines).toHaveLength(8);
    expect(s.lines.map((l) => l.amount)).toEqual(o.lines.map((l) => l.amount));
    expect(s.lines.map((l) => l.date)).toEqual(o.lines.map((l) => l.date));
    expect(s.lines[0]!.fitid).toBe('66f1a000-0000-0000-0000-000000000001');
    expect(s.lines[1]!.raw).toContain('FULANO DE TAL');
    expect(s.lines[1]!.posted_at).toBeUndefined();
  });

  it('parses the card bill with the liability sign convention', () => {
    const s = parseNubankCsv(read('nubank-card.csv').toString('utf8'), 'Nubank_2026-10-05.csv');
    expect(s.kind).toBe('card');
    expect(s.period_end).toBe('2026-10-05');
    expect(s.period_start).toBeNull();
    expect(s.lines).toHaveLength(5);
    const pay = s.lines.find((l) => l.raw === 'Pagamento recebido')!;
    expect(pay.amount).toBe(1234.56);
    expect(pay.kind).toBe('credit');
    const charge = s.lines.find((l) => l.raw === 'Tampopo Alimentos')!;
    expect(charge.amount).toBe(-45.9);
    expect(charge.kind).toBe('debit');
    const inst = s.lines.filter((l) => l.raw === 'Loja X - Parcela 2/5');
    expect(inst).toHaveLength(2);
    expect(inst[0]!.installment).toEqual({ current: 2, total: 5 });
    expect(inst[0]!.hash).not.toBe(inst[1]!.hash);
    expect(s.lines.find((l) => l.raw === 'Netflix.com, Inc')!.amount).toBe(-55.9);
  });

  it('rejects unknown headers', () => {
    const s = parseNubankCsv(read('generic.csv').toString('utf8'), 'generic.csv');
    expect(s.lines).toHaveLength(0);
    expect(s.warnings[0]).toMatch(/unrecognised CSV header/);
  });
});

describe('pdf text', () => {
  it('reads day headers, movements and balances', () => {
    const text = [
      'Extrato Nubank  Conta: 12345678',
      'Saldo inicial                           R$ 660,00',
      '01 OUT 2026',
      'Compra no débito - TAMPOPO ALIMENTOS LTDA          R$ 45,90',
      '03 OUT 2026',
      'Transferência recebida pelo Pix - EMPRESA           R$ 3.500,00',
      'Saldo final                             R$ 4.114,10',
    ].join('\n');
    const s = parseNubankPdfText(text);
    expect(s.institution).toBe('nubank');
    expect(s.account_ref).toBe('12345678');
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]!.amount).toBe(-45.9);
    expect(s.lines[1]!.amount).toBe(3500);
    expect(s.opening_balance).toBe(660);
    expect(s.closing_balance).toBe(4114.1);
    expect(s.lines[1]!.balance_after).toBe(4114.1);
    expect(parseNubankPdfText('nothing here').warnings).toContain('no movements recognised in PDF text');
  });
});

describe('detect', () => {
  it('detectFormat by magic bytes and extension', () => {
    expect(detectFormat('x.pdf', Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(detectFormat('x.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe('image');
    expect(detectFormat('x.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image');
    expect(detectFormat('x.xlsx', Buffer.from('PK\x03\x04'))).toBe('xlsx');
    expect(detectFormat('x.zip', Buffer.from('PK\x03\x04'))).toBe('other');
    expect(detectFormat('stmt.ofx', read('nubank-account.ofx'))).toBe('ofx');
    expect(detectFormat('whatever.txt', read('nubank-account-xml.ofx'))).toBe('ofx');
    expect(detectFormat('x.csv', read('nubank-card.csv'))).toBe('csv');
    expect(detectFormat('data.txt', Buffer.from('a,b\n1,2\n'))).toBe('csv');
    expect(detectFormat('x.bin', Buffer.from([0, 1, 2, 3]))).toBe('other');
  });

  it('detectInstitution follows the Nubank rules', () => {
    expect(detectInstitution({ filename: 'NU_1_01OUT2026_11OUT2026.ofx', sender: 'todomundo@nubank.com.br', subject: 'Extrato da sua conta do Nubank' })).toEqual({ institution: 'nubank', kind: 'account' });
    expect(detectInstitution({ filename: 'Nubank_2026-10-05.csv', sender: 'todomundo@nubank.com.br', subject: 'Extrato da fatura do Cartão Nubank' })).toEqual({ institution: 'nubank', kind: 'card' });
    expect(detectInstitution({ filename: 'NU_1_01OUT2026_11OUT2026.csv' })).toEqual({ institution: 'nubank', kind: 'account' });
    expect(detectInstitution({ filename: 'Nubank_2026-10-05.csv' })).toEqual({ institution: 'nubank', kind: 'card' });
    expect(detectInstitution({ filename: 'statement.pdf', sender: 'noreply@wise.com' })).toEqual({ institution: 'wise', kind: 'account' });
    expect(detectInstitution({ filename: 'whatever.pdf', sender: 'a@b.com' })).toEqual({ institution: null, kind: 'other' });
  });

  it('parseStatementFile dispatches', async () => {
    const ofx = await parseStatementFile(path.join(fixtures, 'nubank-account.ofx'), 'nubank-account.ofx');
    expect(ofx.format).toBe('ofx');
    expect(ofx.parsed?.lines).toHaveLength(8);
    const csv = await parseStatementFile(path.join(fixtures, 'nubank-card.csv'), 'Nubank_2026-10-05.csv', { sender: 'todomundo@nubank.com.br', subject: 'Extrato da fatura do Cartão Nubank' });
    expect(csv.format).toBe('csv');
    expect(csv.parsed?.kind).toBe('card');
    const generic = await parseStatementFile(path.join(fixtures, 'generic.csv'), 'generic.csv');
    expect(generic.parsed?.lines).toHaveLength(0);
    expect(generic.error).toBeUndefined();
  });
});

describe('match helpers', () => {
  it('extractCounterparty and isCardPayment', () => {
    expect(extractCounterparty('Transferência enviada pelo Pix - FULANO DE TAL - •••.123.456-•• - BANCO EXEMPLO S.A.')).toBe('FULANO DE TAL');
    expect(extractCounterparty('Compra no débito - X')).toBeNull();
    expect(isCardPayment('Pagamento de fatura')).toBe(true);
    expect(isCardPayment('Pagamento recebido')).toBe(true);
    expect(isCardPayment('Pagamento da Fatura')).toBe(true);
    expect(isCardPayment('Compra')).toBe(false);
  });

  it('assignAutoMatches vouches only lines with exactly one free candidate, one transaction per line', () => {
    const m = assignAutoMatches([
      { hash: 'a', id: 't1', dd: 0 },
      { hash: 'b', id: 't1', dd: 1 }, // b shares t1 with a and also has t2
      { hash: 'b', id: 't2', dd: 2 },
      { hash: 'c', id: 't3', dd: 0 },
      { hash: 'c', id: 't4', dd: 1 }, // c stays ambiguous
      { hash: 'd', id: 't5', dd: 0 },
    ], new Set(['t5'])); // t5 already taken by a FITID match
    expect(m.get('a')).toBe('t1');
    expect(m.get('b')).toBe('t2'); // disambiguated once a took t1
    expect(m.has('c')).toBe(false);
    expect(m.has('d')).toBe(false);
  });

  it('pairTransfers pairs opposite amounts within a day', () => {
    const mk = (hash: string, date: string, amount: number): StatementLine => ({ hash, date, amount, currency: 'BRL', raw: hash, description_hint: hash, kind: amount < 0 ? 'debit' : 'credit' });
    const a = [mk('a1', '2026-10-05', -1234.56), mk('a2', '2026-10-06', -50)];
    const b = [mk('b1', '2026-10-06', 1234.56), mk('b2', '2026-10-09', 50)];
    expect(pairTransfers(a, b)).toEqual([{ a: 'a1', b: 'b1' }]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('matchLines against a database', () => {
  let client: pg.PoolClient;
  let pool: pg.Pool;
  let accountId: string;
  let categoryId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    const acc = await client.query(`INSERT INTO accounts (name, type, subtype) VALUES ('zz-test-conta', 'asset', 'checking') RETURNING id`);
    accountId = acc.rows[0].id;
    const cat = await client.query(`INSERT INTO accounts (name, type, subtype) VALUES ('zz-test-categoria', 'expense', 'category') RETURNING id`);
    categoryId = cat.rows[0].id;
    const entries = (amt: number) => JSON.stringify([
      { account_id: categoryId, amount: amt, currency: 'BRL', amount_base: amt },
      { account_id: accountId, amount: -amt, currency: 'BRL', amount_base: -amt },
    ]);
    await client.query(`SELECT create_transaction('2026-10-01', 'Tampopo', $1::jsonb, '{"fitid":"FIT-A","statement_line":{"raw":"TAMPOPO ALIMENTOS LTDA"}}'::jsonb)`, [entries(45.9)]);
    await client.query(`SELECT create_transaction('2026-10-07', 'Supermercado Exemplo', $1::jsonb)`, [entries(89.9)]);
    for (let i = 1; i <= 4; i++) {
      await client.query(`SELECT create_transaction($2::date, 'Zztestmercante', $1::jsonb, '{"statement_line":{"raw":"ZZTESTMERCANTE EXEMPLO LTDA"}}'::jsonb)`, [entries(77.7), `2026-09-${String(i * 5).padStart(2, '0')}`]);
    }
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  });

  it('flags fitid matches, likely duplicates, aliases and candidates', async () => {
    const o = parseOfx(decodeOfxBuffer(read('nubank-account.ofx')));
    const lines = o.lines.map((l) => (l.fitid === '66f1a0000000000000000001' ? { ...l, fitid: 'FIT-A' } : l));
    const matched = await matchLines(client, lines, accountId);
    const tampopo = matched.find((l) => l.fitid === 'FIT-A')!;
    expect(tampopo.already_in_ledger).toBe(true);
    expect(tampopo.ledger_transaction_id).toBeTruthy();
    expect(tampopo.candidates).toBeUndefined();
    expect(tampopo.alias?.canonical_description).toBe('Tampopo');

    // same amount, one free candidate on the account within 3 days → vouched by the system, no item needed
    const market = matched.find((l) => l.raw.includes('SUPERMERCADO EXEMPLO'))!;
    expect(market.already_in_ledger).toBe(false);
    expect(market.auto_matched).toBe(true);
    expect(market.ledger_transaction_id).toBeTruthy();
    expect(market.likely_duplicate).toBe(false);
    expect(market.candidates).toBeUndefined();

    const pix = matched.find((l) => l.raw.includes('FULANO DE TAL'))!;
    expect(pix.counterparty).toBe('FULANO DE TAL');
    expect(pix.already_in_ledger).toBe(false);
    expect(pix.likely_duplicate).toBe(false);

    const uber = matched.find((l) => l.raw.includes('UBER'))!;
    expect(uber.candidates === undefined || Array.isArray(uber.candidates)).toBe(true);
  });

  it('classifies a line whose history exists', async () => {
    const line: StatementLine = { hash: 'x', date: '2026-10-14', amount: -77.7, currency: 'BRL', raw: 'ZZTESTMERCANTE EXEMPLO LTDA', description_hint: 'Zztestmercante Exemplo', kind: 'debit' };
    const [m] = await matchLines(client, [line], accountId);
    expect(m!.candidates?.[0]?.category_name).toBe('zz-test-categoria');
    expect(m!.candidates?.[0]?.confidence).toBeGreaterThan(0.5);
    expect(m!.alias?.canonical_description).toBe('Zztestmercante');
  });
});

describe('itau pdf text', () => {
  const text = [
    '                    FULANO DE TAL           000.000.000-00    agência: 1234    conta: 56789-0',
    'saldo em conta               Limite da Conta utilizado',
    'R$ 1.580,48                  R$ 0,00',
    'extrato conta / lançamentos',
    'período de visualização: 17/07/2026 até 15/10/2026                 emitido em: 15/10/2026      14:19:15',
    'data              lançamentos                                     valor (R$)                  saldo (R$)',
    '15/10/2026 SALDO DO DIA                                                                 1.580,48',
    '13/10/2026 PIX QRS CHAPADA IND10/10                                   -339,60',
    '13/10/2026 PIX TRANSF Laura R13/10                                     170,00',
    '13/10/2026 REND PAGO APLIC AUT MAIS                                      0,01',
    '13/10/2026 SALDO DO DIA                                                                 1.580,43',
    '05/10/2026 FINANC IMOBILIARIO 001/420                               -6.555,64',
    '05/10/2026 SALDO DO DIA                                                                 1.750,02',
    '05/10/2026 PIX TRANSF MUNDO N03/10                                    -128,00',
    '01/10/2026 TED 001.3826.FULANO D T                                  8.433,66',
    '01/10/2026 SALDO DO DIA                                                                 8.433,66',
    '16/07/2026 SALDO DO DIA                                                                     0,00',
    'Aviso! Os saldos acima são baseados nas informações disponíveis.',
  ].join('\n');

  it('reads rows, day balances, period, account and warns when the balances do not add up', () => {
    const s = parseItauPdfText(text);
    expect(s.institution).toBe('itau');
    expect(s.account_ref).toBe('1234-56789-0');
    expect(s.period_start).toBe('2026-07-17');
    expect(s.period_end).toBe('2026-10-15');
    expect(s.opening_balance).toBe(0);
    expect(s.closing_balance).toBe(1580.48);
    expect(s.lines.map((l) => l.date)).toEqual(['2026-10-01', '2026-10-05', '2026-10-05', '2026-10-13', '2026-10-13', '2026-10-13']);
    expect(s.lines.find((l) => l.raw.startsWith('FINANC'))!.amount).toBe(-6555.64);
    expect(s.lines[s.lines.length - 1]!.balance_after).toBe(1580.43);
    expect(s.warnings.some((w) => w.includes('do not add up'))).toBe(true);
    expect(parsePdfText(text).institution).toBe('itau');
    expect(detectInstitution({ filename: 'itau_extrato_072026.pdf' })).toEqual({ institution: 'itau', kind: 'account' });
  });
});

describe('brb pdf text', () => {
  // Layout of the BRB app export (pdftotext -layout): no year on the rows, newest first, month headers
  // printed out of place, most rows split over history / date+value / counterparty lines, no balances.
  const text = [
    '                                                            Extrato',
    '                                                FULANO DE TAL',
    '',
    '                                            Agência: 040 — Conta Corrente: 040.000.000-1',
    '',
    '                                                         15/10/2026 15:19',
    'OUTUBRO/2026',
    'SETEMBRO/2026',
    '',
    ' Dia          Histórico                                                                            Valor',
    '',
    ' 13/10        CRED JUROS LIQUIDO CDB AUTOMAT – DOC: 000000                                     R$ +0,27',
    'AGOSTO/2026',
    '',
    ' Dia          Histórico                                                                            Valor',
    '',
    '              CREDITO DE TED PAG C.CORRENTE – DOC: 408695',
    ' 10/09                                                                                        R$ +57,54',
    '              PLANO DE SAUDE EXEMPLO — 89000054',
    'JULHO/2026',
    '',
    ' Dia          Histórico                                                                            Valor',
    '',
    '              DEBITO PIX – DOC: 000000',
    ' 05/08                                                                                     R$ \u221210.333,77',
    '              Fulano de Tal — 4671',
    '',
    '              CREDITO TED PAG CONTA SALARIO – DOC: 779878',
    ' 03/08                                                                                     R$ +10.333,77',
    '              00000000',
    '',
    '',
    '',
    ' Dia          Histórico                                                                            Valor',
    '',
    '              DEBITO PIX – DOC: 000000',
    ' 21/07                                                                                       R$ \u2212250,00',
    '              Beltrana Exemplo — 4671',
    '',
    '              DEBITO PIX – DOC: 000000',
    ' 21/07                                                                                       R$ \u2212250,00',
    '              Beltrana Exemplo — 4671',
    '',
    '              DEBITO PIX – DOC: 000000',
    ' 17/07                                                                                       R$ \u2212187,25',
    '              COMPANHIA DE LUZ — 4671',
  ].join('\n');

  it('reads rows, infers the year from the emission date and leaves the balances to be filled', () => {
    const s = parseBrbPdfText(text);
    expect(s.institution).toBe('brb');
    expect(s.kind).toBe('account');
    expect(s.account_ref).toBe('040-040.000.000-1');
    expect(s.period_start).toBe('2026-07-17');
    expect(s.period_end).toBe('2026-10-15');
    expect(s.opening_balance).toBeNull();
    expect(s.closing_balance).toBeNull();
    expect(s.warnings.some((w) => w.includes('no balance'))).toBe(true);
    expect(s.lines.map((l) => [l.date, l.amount])).toEqual([
      ['2026-07-17', -187.25],
      ['2026-07-21', -250],
      ['2026-07-21', -250],
      ['2026-08-03', 10333.77],
      ['2026-08-05', -10333.77],
      ['2026-09-10', 57.54],
      ['2026-10-13', 0.27],
    ]);
    const luz = s.lines[0]!;
    expect(luz.raw).toBe('DEBITO PIX COMPANHIA DE LUZ — 4671');
    expect(luz.description_hint).toBe('Companhia de Luz');
    expect(luz.kind).toBe('debit');
    expect(s.lines.find((l) => l.date === '2026-10-13')!.raw).toBe('CRED JUROS LIQUIDO CDB AUTOMAT');
    expect(s.lines.find((l) => l.date === '2026-08-03')!.raw).toBe('CREDITO TED PAG CONTA SALARIO 00000000');
    expect(s.lines.find((l) => l.date === '2026-09-10')!.description_hint).toBe('Plano de Saude Exemplo');
    // two identical rows on the same day keep distinct identities
    expect(new Set(s.lines.map((l) => l.hash)).size).toBe(s.lines.length);
    expect(parsePdfText(text).institution).toBe('brb');
    expect(detectInstitution({ filename: 'extrato-brb.pdf' })).toEqual({ institution: 'brb', kind: 'account' });
  });

  it('steps back a year when the months wrap around', () => {
    const s = parseBrbPdfText(
      [
        '                    Agência: 040 — Conta Corrente: 040.000.000-1',
        '                    05/01/2027 09:00',
        ' Dia          Histórico                                            Valor',
        ' 03/01        CRED JUROS LIQUIDO CDB AUTOMAT – DOC: 000000         R$ +1,00',
        '',
        '              DEBITO PIX – DOC: 000000',
        ' 28/12                                                              R$ \u22125,00',
        '              Loja Exemplo — 4671',
      ].join('\n'),
    );
    expect(s.lines.map((l) => l.date)).toEqual(['2026-12-28', '2027-01-03']);
    expect(s.period_end).toBe('2027-01-05');
  });
});
