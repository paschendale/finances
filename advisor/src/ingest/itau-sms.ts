/**
 * Card purchase alerts sent by SMS (Itaú today). The phone forwards the text as it arrived; this
 * reads the purchase out of it. Anything the patterns do not recognise returns null and the
 * caller hands the text to Claude instead.
 */
export interface SmsCharge {
  institution: string;
  /** Card product as the bank names it ("PERSON BLACK PONTOS") */
  card_name: string | null;
  card_last4: string | null;
  merchant: string;
  /** Positive purchase value in BRL */
  amount: number;
  currency: 'BRL';
  /** YYYY-MM-DD in the household's time zone */
  date: string;
  /** HH:MM when the message carries it */
  time: string | null;
}

// "Compra aprovada no seu PERSON BLACK PONTOS final 6585 - NETFLIX.COM valor RS 20,90 em 04/11, as 16h12."
const ITAU_PURCHASE =
  /compra aprovada (?:no|em) (?:seu|sua)\s+(?<card>.+?)\s+final\s+(?<last4>\d{4})\s*-\s*(?<merchant>.+?)\s+valor\s+R\s?\$?\s?S?\s*(?<amount>[\d.]+,\d{2})\s+em\s+(?<day>\d{1,2})\/(?<month>\d{1,2})(?:\/(?<year>\d{2,4}))?(?:,?\s*[àa]s\s+(?<hh>\d{1,2})h(?<mm>\d{2}))?/i;

/** "1.234,56" → 1234.56 */
export function parseBrlAmount(s: string): number {
  return Number(s.replace(/\./g, '').replace(',', '.'));
}

/**
 * The message has day and month only: take the year that puts the date closest to `now`, never
 * more than a day ahead (an SMS from 31/12 read on 01/01 belongs to the year before).
 */
export function inferYear(day: number, month: number, now: Date, timeZone: string): number {
  const today = now.toLocaleDateString('sv-SE', { timeZone });
  const year = Number(today.slice(0, 4));
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const ahead = (Date.parse(`${candidate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return ahead > 1 ? year - 1 : year;
}

export function parseCardSms(text: string, now: Date = new Date(), timeZone = 'America/Sao_Paulo'): SmsCharge | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  const m = clean.match(ITAU_PURCHASE);
  if (!m?.groups) return null;
  const g = m.groups;
  const day = Number(g.day);
  const month = Number(g.month);
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return null;
  let year = g.year ? Number(g.year) : inferYear(day, month, now, timeZone);
  if (year < 100) year += 2000;
  const amount = parseBrlAmount(g.amount!);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    institution: 'itau',
    card_name: g.card?.trim() || null,
    card_last4: g.last4 ?? null,
    merchant: g.merchant!.trim(),
    amount,
    currency: 'BRL',
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time: g.hh ? `${g.hh.padStart(2, '0')}:${g.mm}` : null,
  };
}
