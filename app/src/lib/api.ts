const API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:3000';

export interface Account {
  account_id: string;
  account_name: string;
  account_type: string;
  balance: number;
}

export interface Entry {
  account_id: string;
  amount: number;
  currency: string;
  exchange_rate: number;
  amount_base: number;
}

export interface Transaction {
  date: string;
  description: string;
  entries: Entry[];
}

export async function fetchAccounts(): Promise<Account[]> {
  const response = await fetch(`${API_URL}/account_balances`);
  if (!response.ok) {
    throw new Error('Failed to fetch accounts');
  }
  return response.json();
}

export async function createTransaction(transaction: Transaction) {
  const response = await fetch(`${API_URL}/rpc/create_transaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(transaction),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create transaction');
  }

  return response.json();
}
