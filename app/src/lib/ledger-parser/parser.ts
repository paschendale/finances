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
    const transferMatch = trimmed.match(/^(.+?)\s*>\s*(.+?)\s+([\d.,]+)(?:\s+([A-Z]{3}))?$/);
    if (transferMatch) {
      const from = transferMatch[1].trim();
      const to = transferMatch[2].trim();
      const amountStr = transferMatch[3].replace(',', '.');
      const amount = parseFloat(amountStr);
      const currency = transferMatch[4] || defaultCurrency;

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
    const xMatch = tokens[i].match(/^(\d+(?:[.,]\d+)?)x(\d+)$/i);
    if (xMatch) {
      amountIndex = i;
      amount = parseFloat(xMatch[1].replace(',', '.'));
      installments = { current: 1, total: parseInt(xMatch[2], 10) };
      break;
    }
    const val = tokens[i].replace(',', '.');
    if (!isNaN(parseFloat(val)) && isFinite(Number(val)) && /^-?\d+([.,]\d+)?$/.test(tokens[i])) {
      amountIndex = i;
      amount = parseFloat(val);
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
    // Check if first remaining token is a currency (3 letters uppercase)
    if (/^[A-Z]{3}$/.test(remainingTokens[0])) {
      currency = remainingTokens[0];
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
