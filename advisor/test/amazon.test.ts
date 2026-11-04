import { describe, it, expect } from 'vitest';
import { isAmazonOrderMail, itemsForCharge, parseAmazonAmount, parseAmazonOrderText, splitByItems } from '../src/ingest/amazon-mail.js';
import { assignCharges, isGenericAmazonName, type ChargeRow, type StoredOrder } from '../src/jobs/amazon-orders.js';

const ORDER = `Seus pedidos

https://www.amazon.com.br/gp/css/order-history?ref_=fed_yo_default

    Agradecemos seu pedido!
Pedido feito

Chega hoje

Cliente - Cidade, UF

Pedido nº
701-4779379-1137063

Visualizar ou editar pedido
https://www.amazon.com.br/your-orders/order-details?orderID=701-4779379-1137063&ref_=p_btn_fed_veo

* Sketchbook A5 100g/m², Canson, ArTBook One, 98 Folhas
  Quantidade: 1
  48.99 BRL

* CANSON Graduate Sketchbook Caderno Multitécnicas A5 200g/m² 14x21,6cm com 36 folhas
  Quantidade: 1
  78.99 BRL


Total
127.98 BRL

©2026 Amazon.com, Inc. ou suas afiliadas`;

const DISCOUNTED = `Pedido nº\r\n702-2143101-4255447\r\n\r\n* Leite Vegetal A Tal da Castanha Barista Aveia Caixa 1L\r\n  Quantidade: 10\r\n  22.9 BRL\r\n\r\nTotal\r\n206.1 BRL\r\n`;

describe('Amazon order mails', () => {
  it('recognises order and payment mails by sender and subject', () => {
    expect(isAmazonOrderMail('auto-confirm@amazon.com.br', 'Pedido: "CANSON Graduate Sketchbook..." e 1 produto a mais')).toBe('order');
    expect(isAmazonOrderMail('payments-update@amazon.com.br', 'Confirmação de pagamento: “OMO Lava-Roupas Líquido...”')).toBe('payment');
    expect(isAmazonOrderMail('shipment-tracking@amazon.com.br', 'Enviado: "OMO..."')).toBeNull();
    expect(isAmazonOrderMail('auto-confirm@amazon.com.br', 'Sua devolução')).toBeNull();
  });

  it('reads order number, items and total', () => {
    const o = parseAmazonOrderText(ORDER)!;
    expect(o.order_ref).toBe('701-4779379-1137063');
    expect(o.items).toEqual([
      { name: 'Sketchbook A5 100g/m², Canson, ArTBook One, 98 Folhas', quantity: 1, unit_price: 48.99 },
      { name: 'CANSON Graduate Sketchbook Caderno Multitécnicas A5 200g/m² 14x21,6cm com 36 folhas', quantity: 1, unit_price: 78.99 },
    ]);
    expect(o.total).toBe(127.98);
  });

  it('keeps unit price and quantity apart (CRLF too)', () => {
    const o = parseAmazonOrderText(DISCOUNTED)!;
    expect(o.items[0]).toMatchObject({ quantity: 10, unit_price: 22.9 });
    expect(o.total).toBe(206.1);
  });

  it('returns null without an order number', () => {
    expect(parseAmazonOrderText('Sua opinião é importante!')).toBeNull();
  });

  it('parseAmazonAmount', () => {
    expect(parseAmazonAmount('1953.15')).toBe(1953.15);
    expect(parseAmazonAmount('1,953.15')).toBe(1953.15);
    expect(parseAmazonAmount('1.953,15')).toBe(1953.15);
  });
});

describe('itemsForCharge', () => {
  const four = { total: 230.81, items: [
    { name: 'Aquarela', quantity: 1, unit_price: 89.9 },
    { name: 'Godê', quantity: 1, unit_price: 20.81 },
    { name: 'Livro aquarela', quantity: 1, unit_price: 69.9 },
    { name: 'Canson', quantity: 1, unit_price: 50.2 },
  ] };

  it('the whole order when the charge is the total, even with a discount', () => {
    expect(itemsForCharge(parseAmazonOrderText(DISCOUNTED)!, 206.1)).toEqual([0]);
  });

  it('a group of items when Amazon charged part of the order', () => {
    expect(itemsForCharge(four, 180.61)).toEqual([0, 1, 2]);
    expect(itemsForCharge(four, 50.2)).toEqual([3]);
  });

  it('nothing for an unrelated value', () => {
    expect(itemsForCharge(four, 99.99)).toBeNull();
  });
});

describe('splitByItems', () => {
  it('splits in proportion and adds up to the cent', () => {
    const parts = splitByItems([{ name: 'a', quantity: 1, unit_price: 26.4 }, { name: 'b', quantity: 1, unit_price: 54.56 }], 80.96);
    expect(parts).toEqual([26.4, 54.56]);
    const scaled = splitByItems([{ name: 'a', quantity: 1, unit_price: 10 }, { name: 'b', quantity: 2, unit_price: 10 }], 27);
    expect(scaled).toEqual([9, 18]);
    const odd = splitByItems([{ name: 'a', quantity: 1, unit_price: 1 }, { name: 'b', quantity: 1, unit_price: 1 }, { name: 'c', quantity: 1, unit_price: 1 }], 10);
    expect(odd.reduce((s, x) => s + x, 0)).toBeCloseTo(10, 5);
  });
});

describe('assignCharges', () => {
  const order = (ref: string, at: string, items: Array<[string, number]>, total: number | null = null): StoredOrder => ({
    id: ref, order_ref: ref, ordered_at: at, total: total ?? items.reduce((s, [, v]) => s + v, 0),
    items: items.map(([name, v]) => ({ name, quantity: 1, unit_price: v })), status: 'open', charges: [], reported_at: null,
  });
  const charge = (id: string, date: string, amount: number): ChargeRow => ({ transaction_id: id, date, amount, money_account_id: 'card', currency: 'BRL', description: 'Amazon', source: null, legs: [] });

  it('matches by total within the window and never takes a charge twice', () => {
    const a = assignCharges([order('A', '2026-10-22', [['OMO', 23.98]]), order('B', '2026-08-04', [['Bomba', 23.98]])], [charge('t1', '2026-08-04', 23.98), charge('t2', '2026-10-23', 23.98)]);
    expect(a.map((x) => [x.order.order_ref, x.charge.transaction_id])).toEqual([['B', 't1'], ['A', 't2']]);
  });

  it('ignores charges outside the window', () => {
    expect(assignCharges([order('A', '2026-10-01', [['x', 10]])], [charge('t', '2026-11-15', 10)])).toEqual([]);
  });

  it('pays an order with two charges', () => {
    const a = assignCharges([order('A', '2026-09-16', [['Aquarela', 89.9], ['Godê', 20.81], ['Livro', 69.9], ['Canson', 50.2]])], [charge('t1', '2026-09-18', 180.61), charge('t2', '2026-09-20', 50.2)]);
    expect(a.map((x) => [x.charge.transaction_id, x.items])).toEqual([['t1', [0, 1, 2]], ['t2', [3]]]);
  });
});

describe('isGenericAmazonName', () => {
  it('only names the household did not choose', () => {
    for (const s of ['Amazon', 'AMAZON BR', 'Amazon Marketplace', 'Amazonmktplc*Raecompan', 'Amazon Br *Amazon']) expect(isGenericAmazonName(s)).toBe(true);
    for (const s of ['Amazon - Balde', 'Amazon (estorno)', 'Livro Murdoku']) expect(isGenericAmazonName(s)).toBe(false);
  });
});
