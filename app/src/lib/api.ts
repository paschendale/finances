const API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:3000';

export interface Account {
  account_id: string;
  account_name: string;
  account_type: string;
  balance: number;
}

export interface Entry {
  id: string;
  account_id: string;
  account_name: string;
  account_type: string;
  amount: number;
  currency: string;
  exchange_rate: number;
  amount_base: number;
}

export interface Transaction {
  id: string;
  date: string;
  description: string;
  metadata?: Record<string, any>;
  entries: Entry[];
  account_ids?: string[];
}

export async function fetchAccounts(): Promise<Account[]> {
  const response = await fetch(`${API_URL}/account_balances`);
  if (!response.ok) {
    throw new Error('Failed to fetch accounts');
  }
  return response.json();
}

export async function fetchTransactions(
  limit = 100, 
  offset = 0, 
  startDate?: string, 
  endDate?: string, 
  accountIds?: string[]
): Promise<Transaction[]> {
  const params = new URLSearchParams();
  params.append('order', 'date.desc,created_at.desc');
  params.append('limit', limit.toString());
  params.append('offset', offset.toString());

  if (startDate) params.append('date', `gte.${startDate}`);
  if (endDate) params.append('date', `lte.${endDate}`);
  if (accountIds && accountIds.length > 0) {
    params.append('account_ids', `ov.{${accountIds.join(',')}}`);
  }

  const response = await fetch(`${API_URL}/transactions_with_entries?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch transactions');
  }
  return response.json();
}

export interface CategoryUsage {
  category_name: string;
  category_type: string;
  total: number;
}

export interface DashboardEntry {
  date: string;
  amount_base: number;
  account_name: string;
  account_type: string;
  account_id: string;
}

export async function fetchDashboardData(startDate?: string, endDate?: string): Promise<DashboardEntry[]> {
  let url = `${API_URL}/dashboard_data`;
  const params = new URLSearchParams();
  if (startDate) params.append('date', `gte.${startDate}`);
  if (endDate) params.append('date', `lte.${endDate}`);
  if (params.toString()) url += `?${params.toString()}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch dashboard data');
  }
  return response.json();
}

export async function fetchCategoryUsage(): Promise<CategoryUsage[]> {
  const response = await fetch(`${API_URL}/category_totals?order=total.desc&limit=10`);
  if (!response.ok) {
    throw new Error('Failed to fetch category usage');
  }
  return response.json();
}

export interface DescriptionMemory {
  description: string;
  category_id: string;
  category_name: string;
  account_id: string;
  account_name: string;
  currency: string;
  updated_at: string;
}

export async function fetchDescriptionMemories(): Promise<DescriptionMemory[]> {
  const response = await fetch(`${API_URL}/description_memories_with_names?order=updated_at.desc`);
  if (!response.ok) {
    throw new Error('Failed to fetch description memories');
  }
  return response.json();
}

export interface GlobalSetting {
  key: string;
  value: string;
}

export async function fetchGlobalSettings(): Promise<GlobalSetting[]> {
  const response = await fetch(`${API_URL}/global_settings`);
  if (!response.ok) {
    throw new Error('Failed to fetch global settings');
  }
  return response.json();
}

export interface DailyBalance {
  date: string;
  account_type: string;
  balance: number;
}

export async function fetchDailyBalances(): Promise<DailyBalance[]> {
  const response = await fetch(`${API_URL}/daily_balances?order=date.asc`);
  if (!response.ok) {
    throw new Error('Failed to fetch daily balances');
  }
  return response.json();
}

export interface DailyAccountBalance {
  date: string;
  account_id: string;
  balance: number;
}

export async function fetchDailyAccountBalances(dates: string[], accountIds: string[]): Promise<DailyAccountBalance[]> {
  const params = new URLSearchParams();
  if (dates.length > 0) params.append('date', `in.(${dates.join(',')})`);
  if (accountIds.length > 0) params.append('account_id', `in.(${accountIds.join(',')})`);
  
  const response = await fetch(`${API_URL}/daily_account_balances?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch daily account balances');
  }
  return response.json();
}

export async function createTransaction(transaction: Omit<Transaction, 'id' | 'entries'> & { entries: Omit<Entry, 'id' | 'account_name' | 'account_type'>[] }) {
  const response = await fetch(`${API_URL}/rpc/create_transaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_date: transaction.date,
      p_description: transaction.description,
      p_entries: transaction.entries,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create transaction');
  }

  return response.json();
}

export async function updateTransaction(transaction: Transaction) {
  const response = await fetch(`${API_URL}/rpc/update_transaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_id: transaction.id,
      p_date: transaction.date,
      p_description: transaction.description,
      p_entries: transaction.entries.map(({ id, account_name, account_type, created_at, ...rest }: any) => rest),
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update transaction');
  }

  return response.json();
}
