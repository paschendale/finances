import { describe, it, expect } from 'vitest';
import { parseQuickEntry, type ParserContext } from './parser';

describe('parseQuickEntry Specs', () => {
  const defaultContext: ParserContext = {
    defaultCurrency: 'BRL',
    selectedAccount: 'nubank',
    selectedDate: '2026-03-08',
  };

  const runTest = (input: string, expected: any, context = defaultContext) => {
    const result = parseQuickEntry(input, context);
    Object.keys(expected).forEach(key => {
      const val = expected[key];
      if (typeof val === 'object') {
        expect(result[key as keyof typeof result]).toEqual(val);
      } else {
        expect(result[key as keyof typeof result]).toBe(val);
      }
    });
  };

  describe('Transfers', () => {
    it('1. wise > nubank 18000', () => {
      runTest('wise > nubank 18000', {
        type: 'transfer',
        from: 'wise',
        to: 'nubank',
        amount: 18000,
        currency: 'BRL'
      });
    });

    it('2. wise > nubank 18000 USD', () => {
      runTest('wise > nubank 18000 USD', {
        type: 'transfer',
        from: 'wise',
        to: 'nubank',
        amount: 18000,
        currency: 'USD'
      });
    });

    it('3. nubank > wise 1000', () => {
      runTest('nubank > wise 1000', {
        type: 'transfer',
        from: 'nubank',
        to: 'wise',
        amount: 1000
      });
    });

    it('4. itau > nubank 500.50', () => {
      runTest('itau > nubank 500.50', {
        type: 'transfer',
        from: 'itau',
        to: 'nubank',
        amount: 500.50,
        currency: 'BRL'
      });
    });

    it('5. wise > nubank 100 EUR', () => {
      runTest('wise > nubank 100 EUR', {
        type: 'transfer',
        from: 'wise',
        to: 'nubank',
        amount: 100,
        currency: 'EUR'
      });
    });

    it('29. wise>nubank 1000', () => {
      runTest('wise>nubank 1000', {
        type: 'transfer',
        from: 'wise',
        to: 'nubank',
        amount: 1000
      });
    });

    it('30. wise > nubank 1000 USD', () => {
      runTest('wise > nubank 1000 USD', {
        type: 'transfer',
        from: 'wise',
        to: 'nubank',
        amount: 1000,
        currency: 'USD'
      });
    });

    it('31. nubank > cash 200', () => {
      runTest('nubank > cash 200', {
        type: 'transfer',
        from: 'nubank',
        to: 'cash',
        amount: 200
      });
    });

    it('32. wise > nubank 500 EUR', () => {
      runTest('wise > nubank 500 EUR', {
        type: 'transfer',
        amount: 500,
        currency: 'EUR'
      });
    });
  });

  describe('Basic Expenses', () => {
    it('6. padaria 18', () => {
      runTest('padaria 18', {
        type: 'expense',
        description: 'padaria',
        account: 'nubank',
        amount: 18,
        currency: 'BRL'
      });
    });

    it('7. padaria 18.79', () => {
      runTest('padaria 18.79', {
        type: 'expense',
        description: 'padaria',
        account: 'nubank',
        amount: 18.79,
        currency: 'BRL'
      });
    });

    it('8. padaria estacionamento 18', () => {
      runTest('padaria estacionamento 18', {
        description: 'padaria estacionamento',
        amount: 18,
        account: 'nubank',
        currency: 'BRL'
      });
    });

    it('9. uber 32', () => {
      runTest('uber 32', {
        description: 'uber',
        amount: 32,
        account: 'nubank',
        currency: 'BRL'
      });
    });

    it('10. mercado 120', () => {
      runTest('mercado 120', {
        description: 'mercado',
        amount: 120,
        account: 'nubank',
        currency: 'BRL'
      });
    });
  });

  describe('Multi-word descriptions', () => {
    it('11. almoço restaurante 48', () => {
      runTest('almoço restaurante 48', {
        description: 'almoço restaurante',
        amount: 48
      });
    });

    it('12. estacionamento shopping 25', () => {
      runTest('estacionamento shopping 25', {
        description: 'estacionamento shopping',
        amount: 25
      });
    });

    it('13. padaria domingo 32', () => {
      runTest('padaria domingo 32', {
        description: 'padaria domingo',
        amount: 32
      });
    });
  });

  describe('Currency handling', () => {
    it('14. padaria 5 USD', () => {
      runTest('padaria 5 USD', {
        description: 'padaria',
        amount: 5,
        currency: 'USD',
        account: 'nubank'
      });
    });

    it('15. uber 12 EUR', () => {
      runTest('uber 12 EUR', {
        description: 'uber',
        amount: 12,
        currency: 'EUR'
      });
    });

    it('16. mercado 100 BRL', () => {
      runTest('mercado 100 BRL', {
        description: 'mercado',
        amount: 100,
        currency: 'BRL'
      });
    });
  });

  describe('Explicit account override', () => {
    it('17. padaria 18 itau', () => {
      runTest('padaria 18 itau', {
        account: 'itau',
        amount: 18,
        description: 'padaria'
      });
    });

    it('18. uber 32 wise', () => {
      runTest('uber 32 wise', {
        account: 'wise',
        amount: 32
      });
    });

    it('19. mercado 120 cash', () => {
      runTest('mercado 120 cash', {
        account: 'cash',
        amount: 120
      });
    });
  });

  describe('Numbers inside description', () => {
    it('20. restaurante 2 pessoas 90', () => {
      runTest('restaurante 2 pessoas 90', {
        description: 'restaurante 2 pessoas',
        amount: 90
      });
    });

    it('21. cerveja 3 unidades 24', () => {
      runTest('cerveja 3 unidades 24', {
        description: 'cerveja 3 unidades',
        amount: 24
      });
    });

    it('22. pizza 4 queijos 70', () => {
      runTest('pizza 4 queijos 70', {
        description: 'pizza 4 queijos',
        amount: 70
      });
    });
  });

  describe('Edge formatting', () => {
    it('23. padaria   18', () => {
      runTest('padaria   18', {
        description: 'padaria',
        amount: 18
      });
    });

    it('24.    padaria 18', () => {
      runTest('   padaria 18', {
        description: 'padaria',
        amount: 18
      });
    });

    it('25. padaria 18   ', () => {
      runTest('padaria 18   ', {
        description: 'padaria',
        amount: 18
      });
    });
  });

  describe('Decimal edge cases', () => {
    it('26. café 4.5', () => {
      runTest('café 4.5', {
        amount: 4.5
      });
    });

    it('27. café 4.50', () => {
      runTest('café 4.50', {
        amount: 4.5
      });
    });

    it('28. uber 32.00', () => {
      runTest('uber 32.00', {
        amount: 32
      });
    });
  });

  describe('Installments', () => {
    it('36. Compra (1 de 12) 120', () => {
      runTest('Compra (1 de 12) 120', {
        type: 'expense',
        description: 'Compra',
        amount: 120,
        installments: { current: 1, total: 12 },
      });
    });

    it('37. Compra (3 de 12) 120', () => {
      runTest('Compra (3 de 12) 120', {
        type: 'expense',
        description: 'Compra',
        amount: 120,
        installments: { current: 3, total: 12 },
      });
    });

    it('38. Compra 120x12', () => {
      runTest('Compra 120x12', {
        type: 'expense',
        description: 'Compra',
        amount: 120,
        installments: { current: 1, total: 12 },
      });
    });

    it('39. Compra (1 de 12) 120 BRL nubank', () => {
      runTest('Compra (1 de 12) 120 BRL nubank', {
        type: 'expense',
        description: 'Compra',
        amount: 120,
        currency: 'BRL',
        account: 'nubank',
        installments: { current: 1, total: 12 },
      });
    });

    it('40. padaria 18 has no installments', () => {
      runTest('padaria 18', {
        installments: undefined,
      });
    });
  });

  describe('Ambiguous inputs / Errors', () => {
    it('33. padaria', () => {
      runTest('padaria', {
        type: 'error',
        error: 'missing amount'
      });
    });

    it('34. 18', () => {
      runTest('18', {
        type: 'error',
        error: 'missing description'
      });
    });

    it('35. empty string', () => {
      runTest('', {
        type: 'error',
        error: 'empty input'
      });
    });
  });
});
