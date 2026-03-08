export interface Entry {
  account: string;
  amount: number;
}

export interface TransactionPreview {
  date: string;
  description: string;
  entries: Entry[];
}

export function parseQuickEntry(input: string): TransactionPreview {
  let today = new Date().toISOString().split('T')[0];
  let trimmed = input.trim();

  // Check for date prefix: YYYY-MM-DD
  const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
  if (dateMatch) {
    today = dateMatch[1];
    trimmed = dateMatch[2].trim();
  }

  // Check for income: <to> < <from> <amount>
  const incomeMatch = trimmed.match(/^(.+?)\s*<\s*(.+?)\s+([\d.,]+)$/);
  if (incomeMatch) {
    const toAccount = incomeMatch[1].trim();
    const fromAccount = incomeMatch[2].trim();
    const amountStr = incomeMatch[3].replace(',', '.');
    const amount = parseFloat(amountStr);

    return {
      date: today,
      description: `Income from ${fromAccount} to ${toAccount}`,
      entries: [
        { account: `assets:${toAccount}`, amount },
        { account: `income:${fromAccount}`, amount: -amount },
      ],
    };
  }

  // Check for transfer: <from> > <to> <amount>
  const transferMatch = trimmed.match(/^(.+?)\s*>\s*(.+?)\s+([\d.,]+)$/);
  if (transferMatch) {
    const fromAccount = transferMatch[1].trim();
    const toAccount = transferMatch[2].trim();
    const amountStr = transferMatch[3].replace(',', '.');
    const amount = parseFloat(amountStr);

    return {
      date: today,
      description: `Transfer from ${fromAccount} to ${toAccount}`,
      entries: [
        { account: `assets:${fromAccount}`, amount: -amount },
        { account: `assets:${toAccount}`, amount: amount },
      ],
    };
  }

  // Check for expense: <description> <amount>
  const expenseMatch = trimmed.match(/^(.+?)\s+([\d.,]+)$/);
  if (expenseMatch) {
    const description = expenseMatch[1].trim();
    const amountStr = expenseMatch[2].replace(',', '.');
    const amount = parseFloat(amountStr);

    return {
      date: today,
      description,
      entries: [
        { account: 'expenses:unknown', amount },
        { account: 'assets:unknown', amount: -amount },
      ],
    };
  }

  // Fallback
  return {
    date: today,
    description: trimmed,
    entries: [],
  };
}
