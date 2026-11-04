import { describe, it, expect } from 'vitest';
import { inferYear, parseBrlAmount, parseCardSms } from '../src/ingest/itau-sms.js';

const now = new Date('2026-11-04T20:00:00Z');
const TZ = 'America/Sao_Paulo';

describe('parseCardSms (Itaú)', () => {
  it('reads the purchase alert as Itaú sends it', () => {
    const r = parseCardSms('Compra aprovada no seu PERSON BLACK PONTOS final 6585 - NETFLIX.COM valor RS 20,90 em 04/11, as 16h12.', now, TZ);
    expect(r).toEqual({
      institution: 'itau',
      card_name: 'PERSON BLACK PONTOS',
      card_last4: '6585',
      merchant: 'NETFLIX.COM',
      amount: 20.9,
      currency: 'BRL',
      date: '2026-11-04',
      time: '16:12',
    });
  });

  it('accepts R$, thousands, accents and extra spaces', () => {
    const r = parseCardSms('Compra aprovada no seu PERSON BLACK PONTOS final 6585 -  POSTO SHELL QD 5   valor R$ 1.234,56 em 3/11, às 9h05', now, TZ);
    expect(r?.amount).toBe(1234.56);
    expect(r?.merchant).toBe('POSTO SHELL QD 5');
    expect(r?.date).toBe('2026-11-03');
    expect(r?.time).toBe('09:05');
  });

  it('works without the time', () => {
    const r = parseCardSms('Compra aprovada no seu ITAU UNICLASS final 1234 - PADARIA X valor RS 7,50 em 01/11', now, TZ);
    expect(r?.time).toBeNull();
    expect(r?.card_last4).toBe('1234');
  });

  it('returns null for other messages', () => {
    expect(parseCardSms('Itaú: seu código de segurança é 123456', now, TZ)).toBeNull();
    expect(parseCardSms('Compra aprovada no seu PERSON BLACK final 6585 - LOJA valor RS 0,00 em 04/11', now, TZ)).toBeNull();
  });
});

describe('date helpers', () => {
  it('parseBrlAmount', () => {
    expect(parseBrlAmount('20,90')).toBe(20.9);
    expect(parseBrlAmount('12.345,67')).toBe(12345.67);
  });

  it('inferYear keeps last year for a late-December SMS read in January', () => {
    expect(inferYear(31, 12, new Date('2027-01-01T12:00:00Z'), TZ)).toBe(2026);
    expect(inferYear(4, 11, now, TZ)).toBe(2026);
    // one day ahead is tolerated (time zone edge)
    expect(inferYear(5, 11, now, TZ)).toBe(2026);
  });
});

import { fallbackDescription, smsEventId } from '../src/jobs/ingest-sms.js';
import { smsRoutes } from '../src/http/routes/sms.js';
import type { AppContext } from '../src/context.js';

describe('sms helpers', () => {
  it('fallbackDescription makes a short readable name', () => {
    expect(fallbackDescription('NETFLIX.COM')).toBe('Netflix');
    expect(fallbackDescription('PADARIA PAO QUENTE LTDA')).toBe('Padaria Pao Quente');
    expect(fallbackDescription('UBER* TRIP')).toBe('Uber Trip');
  });

  it('smsEventId ignores spacing and keeps different days apart', () => {
    const a = smsEventId('Compra  aprovada X', '2026-11-04T19:12:00Z');
    expect(smsEventId('Compra aprovada X ', '2026-11-04T23:00:00Z')).toBe(a);
    expect(smsEventId('Compra aprovada X', '2026-11-05T10:00:00Z')).not.toBe(a);
  });
});

describe('POST /sms', () => {
  const ctx = { config: { SMS_TOKEN: 'x'.repeat(32) } } as unknown as AppContext;
  const app = smsRoutes(ctx);

  it('rejects a missing or wrong token', async () => {
    expect((await app.request('/sms', { method: 'POST', body: 'oi' })).status).toBe(401);
    expect((await app.request('/sms', { method: 'POST', body: 'oi', headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('is off when no token is configured', async () => {
    const off = smsRoutes({ config: {} } as unknown as AppContext);
    expect((await off.request('/sms', { method: 'POST', body: 'oi' })).status).toBe(404);
  });

  it('rejects an empty message', async () => {
    const r = await app.request('/sms', { method: 'POST', body: JSON.stringify({ text: '' }), headers: { authorization: `Bearer ${'x'.repeat(32)}`, 'content-type': 'application/json' } });
    expect(r.status).toBe(400);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSmsTokenFile } from '../src/config.js';

describe('readSmsTokenFile', () => {
  it('reads a long enough token and ignores short or missing ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-'));
    expect(readSmsTokenFile(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'sms-token'), 'short\n');
    expect(readSmsTokenFile(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'sms-token'), `${'a'.repeat(30)}\n`);
    expect(readSmsTokenFile(dir)).toBe('a'.repeat(30));
  });
});
