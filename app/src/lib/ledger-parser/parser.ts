export type ParsedType = 'expense' | 'transfer' | 'income' | 'error';

export interface InstallmentInfo {
  current: number; // starting installment (e.g., 3 in "(3 de 12)")
  total: number;   // total installments
}

export interface ParsedInput {
  type: ParsedType;
  description: string;
  amount: number | null;
  currency: string;
  date?: string;
  account?: string; // The "from" account for expenses
  from?: string;    // For transfers
  to?: string;      // For transfers
  error?: string;
  installments?: InstallmentInfo;
}

export interface ParserContext {
  selectedAccount?: string;
  selectedDate?: string;
  defaultCurrency?: string;
}

function parseLocalizedAmountToken(token: string): number | null {
  const trimmed = token.trim();
  if (!trimmed || !/^-?[\d.,]+$/.test(trimmed)) return null;

  const sign = trimmed.startsWith('-') ? -1 : 1;
  const unsigned = trimmed.replace(/^-/, '');
  if (!/\d/.test(unsigned)) return null;

  const lastDot = unsigned.lastIndexOf('.');
  const lastComma = unsigned.lastIndexOf(',');
  const decimalIndex = Math.max(lastDot, lastComma);

  let normalized = '';
  if (decimalIndex === -1) {
    normalized = unsigned.replace(/[.,]/g, '');
  } else {
    const integerPart = unsigned.slice(0, decimalIndex).replace(/[.,]/g, '');
    const fractionalPart = unsigned.slice(decimalIndex + 1).replace(/[.,]/g, '');
    if (!fractionalPart) return null;
    normalized = `${integerPart || '0'}.${fractionalPart}`;
  }

  if (!normalized || !/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? sign * parsed : null;
}

export function parseQuickEntry(input: string, context: ParserContext = {}): ParsedInput {
  const defaultCurrency = context.defaultCurrency || 'BRL';
  const defaultDate = context.selectedDate || new Date().toISOString().split('T')[0];
  const defaultAccount = context.selectedAccount || 'assets:unknown';

  let trimmed = input.trim();
  if (!trimmed) {
    return {
      type: 'error',
      description: '',
      amount: null,
      currency: defaultCurrency,
      error: 'empty input',
    };
  }

  let date = defaultDate;
  // Check for date prefix: YYYY-MM-DD
  const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
  if (dateMatch) {
    date = dateMatch[1];
    trimmed = dateMatch[2].trim();
  }

  // Detect installment pattern: (N de M)
  let installments: InstallmentInfo | undefined;
  const installmentMatch = trimmed.match(/\((\d+)\s+de\s+(\d+)\)/);
  if (installmentMatch) {
    installments = {
      current: parseInt(installmentMatch[1], 10),
      total: parseInt(installmentMatch[2], 10),
    };
    trimmed = trimmed.replace(installmentMatch[0], '').replace(/\s+/g, ' ').trim();
  }

  // Rule 1: Transfers detected by ">"
  if (trimmed.includes('>')) {
    // Regex for transfer: from > to amount [CURRENCY]
    // Allowing no spaces around >
    const transferMatch = trimmed.match(/^(.+?)\s*>\s*(.+?)\s+(-?[\d.,]+)(?:\s+([A-Za-z]{3}))?$/);
    if (transferMatch) {
      const from = transferMatch[1].trim();
      const to = transferMatch[2].trim();
      const amount = parseLocalizedAmountToken(transferMatch[3]);
      const currency = transferMatch[4] ? transferMatch[4].toUpperCase() : defaultCurrency;

      return {
        type: 'transfer',
        description: `Transfer from ${from} to ${to}`,
        from,
        to,
        amount: isNaN(amount) ? null : amount,
        currency,
        date,
      };
    }
  }

  // Rule 2-5: Expenses
  // description amount [CURRENCY] [ACCOUNT]
  // Rule: last numeric token is the amount.
  const tokens = trimmed.split(/\s+/);
  
  // Find the last token that is a valid number
  let amountIndex = -1;
  let amount = null;

  for (let i = tokens.length - 1; i >= 0; i--) {
    // Check for NxM shorthand (e.g. 120x12)
    const xMatch = tokens[i].match(/^(-?[\d.,]+)x(\d+)$/i);
    if (xMatch) {
      const parsedAmount = parseLocalizedAmountToken(xMatch[1]);
      if (parsedAmount !== null) {
        amountIndex = i;
        amount = parsedAmount;
        installments = { current: 1, total: parseInt(xMatch[2], 10) };
        break;
      }
    }
    const parsedAmount = parseLocalizedAmountToken(tokens[i]);
    if (parsedAmount !== null) {
      amountIndex = i;
      amount = parsedAmount;
      break;
    }
  }

  if (amountIndex === -1) {
    return {
      type: 'error',
      description: trimmed,
      amount: null,
      currency: defaultCurrency,
      error: 'missing amount',
    };
  }

  const descriptionTokens = tokens.slice(0, amountIndex);
  if (descriptionTokens.length === 0) {
    return {
      type: 'error',
      description: '',
      amount,
      currency: defaultCurrency,
      error: 'missing description',
    };
  }

  const description = descriptionTokens.join(' ');
  const remainingTokens = tokens.slice(amountIndex + 1);
  
  let currency = defaultCurrency;
  let account = defaultAccount;

  if (remainingTokens.length > 0) {
    // Check if first remaining token is a currency (3 letters, any case)
    if (/^[A-Za-z]{3}$/.test(remainingTokens[0])) {
      currency = remainingTokens[0].toUpperCase();
      if (remainingTokens.length > 1) {
        account = remainingTokens[1];
      }
    } else {
      // First remaining token is account
      account = remainingTokens[0];
    }
  }

  return {
    type: 'expense',
    description,
    amount,
    currency,
    account,
    date,
    installments,
  };
}

export interface Entry {
  account: string;
  amount: number;
}

export interface TransactionPreview {
  date: string;
  description: string;
  entries: Entry[];
}
