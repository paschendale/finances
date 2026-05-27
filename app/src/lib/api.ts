const API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:3000';

export const AUTH_TOKEN_KEY = 'finances_auth_token';

function getHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

export async function loginWithToken(token: string): Promise<string> {
  const response = await fetch(`${API_URL}/rpc/login_with_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Login failed' }));
    throw new Error(error.message || 'Login failed');
  }

  const jwt = await response.json();
  localStorage.setItem(AUTH_TOKEN_KEY, jwt);
  return jwt;
}

let onLogoutCallback: (() => void) | null = null;

export function setOnLogout(callback: () => void) {
  onLogoutCallback = callback;
}

export function logout() {
  const hadToken = !!localStorage.getItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  if (hadToken && onLogoutCallback) {
    onLogoutCallback();
  } else if (hadToken) {
    window.location.reload();
  }
}

export interface Account {
  account_id: string;
  account_name: string;
  account_type: string;
  subtype: string | null;
  balance: number;
  own_balance: number;
  future_balance: number;
  last_entry_date: string | null;
  last_checked: string | null;
  parent_id: string | null;
  icon: string | null;
  color: string | null;
  hidden: boolean;
}

export interface AccountNode {
  id: string;
  name: string;
  full_name: string;
  type: string;
  subtype: string | null;
  parent_id: string | null;
  balance: number;
  own_balance: number;
  future_balance: number;
  last_entry_date: string | null;
  last_checked: string | null;
  icon: string | null;
  color: string | null;
  hidden: boolean;
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
  const response = await fetch(`${API_URL}/account_balances`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch accounts');
  }
  const data: Account[] = await response.json();
  return data.map((a) => ({
    ...a,
    last_checked: a.last_checked ?? null,
    future_balance: a.future_balance ?? 0,
  }));
}

export async function fetchTransactions(
  limit = 100,
  offset = 0,
  startDate?: string,
  endDate?: string,
  accountIds?: string[],
  description?: string
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
  if (description) params.append('description', `ilike.*${description}*`);

  const response = await fetch(`${API_URL}/transactions_with_entries?${params.toString()}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch transactions');
  }
  return response.json();
}

export async function fetchTransactionsForExport(
  startDate?: string,
  endDate?: string,
  accountIds?: string[]
): Promise<Transaction[]> {
  const params = new URLSearchParams();
  params.append('order', 'date.desc,created_at.desc');

  if (startDate) params.append('date', `gte.${startDate}`);
  if (endDate) params.append('date', `lte.${endDate}`);
  if (accountIds && accountIds.length > 0) {
    params.append('account_ids', `ov.{${accountIds.join(',')}}`);
  }

  const response = await fetch(`${API_URL}/transactions_with_entries?${params.toString()}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch transactions for export');
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
  
  const response = await fetch(url, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch dashboard data');
  }
  return response.json();
}

export async function fetchCategoryUsage(): Promise<CategoryUsage[]> {
  const response = await fetch(`${API_URL}/category_totals?order=total.desc&limit=10`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
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
  const response = await fetch(`${API_URL}/description_memories_with_names?order=updated_at.desc`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch description memories');
  }
  return response.json();
}

export interface GlobalSetting {
  key: string;
  value: string;
}

export async function fetchGlobalSettings(): Promise<GlobalSetting[]> {
  const response = await fetch(`${API_URL}/global_settings`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
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
  const response = await fetch(`${API_URL}/daily_balances?order=date.asc`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
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
  
  const response = await fetch(`${API_URL}/daily_account_balances?${params.toString()}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch daily account balances');
  }
  return response.json();
}

export interface DescriptionMatch {
  description: string;
  category_id: string;
  category_name: string;
  category_type: string;
  account_id: string;
  account_name: string;
  account_type: string;
  currency: string;
  similarity: number;
  score: number;
}

export async function matchDescriptionMemory(input: string): Promise<DescriptionMatch[]> {
  const response = await fetch(`${API_URL}/rpc/match_description_memory`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ p_input: input }),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    return [];
  }
  return response.json();
}

export interface AccountMatch {
  account_id: string;
  account_name: string;
  full_name: string;
  type: string;
  similarity: number;
}

export async function matchAccount(input: string): Promise<AccountMatch | null> {
  const response = await fetch(`${API_URL}/rpc/match_account`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ p_input: input }),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    return null;
  }
  const results = await response.json();
  return results.length > 0 ? results[0] : null;
}

export async function createTransaction(transaction: Omit<Transaction, 'id' | 'entries'> & { entries: Omit<Entry, 'id' | 'account_name' | 'account_type'>[] }) {
  const response = await fetch(`${API_URL}/rpc/create_transaction`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      p_date: transaction.date,
      p_description: transaction.description,
      p_entries: transaction.entries,
    }),
  });

  if (!response.ok) {
    if (response.status === 401) logout();
    const error = await response.json();
    throw new Error(error.message || 'Failed to create transaction');
  }

  return response.json();
}

export async function updateTransaction(transaction: Transaction) {
  const response = await fetch(`${API_URL}/rpc/update_transaction`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      p_id: transaction.id,
      p_date: transaction.date,
      p_description: transaction.description,
      p_entries: transaction.entries.map(({ id, account_name, account_type, created_at, ...rest }: any) => rest),
    }),
  });

  if (!response.ok) {
    if (response.status === 401) logout();
    const error = await response.json();
    throw new Error(error.message || 'Failed to update transaction');
  }

  return response.json();
}

export async function deleteTransaction(id: string) {
  const response = await fetch(`${API_URL}/rpc/delete_transaction`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ p_id: id }),
  });

  if (!response.ok) {
    if (response.status === 401) logout();
    const error = await response.json().catch(() => ({ message: 'Failed to delete transaction' }));
    throw new Error(error.message || 'Failed to delete transaction');
  }

  return response.json();
}

export interface AccountUsage {
  account_id: string;
  account_name: string;
  account_type: string;
  usage_count: number;
  hidden: boolean;
}

export async function fetchAccountUsage(): Promise<AccountUsage[]> {
  const response = await fetch(`${API_URL}/account_usage?order=usage_count.desc`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch account usage');
  }
  return response.json();
}

export async function fetchAccountsTree(): Promise<AccountNode[]> {
  const response = await fetch(`${API_URL}/account_balances?order=account_name.asc`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch accounts tree');
  }
  const data = await response.json();
  return data.map((a: any) => ({
    id: a.account_id,
    name: a.leaf_name,
    full_name: a.account_name,
    type: a.account_type,
    subtype: a.subtype ?? null,
    parent_id: a.parent_id,
    balance: a.balance,
    own_balance: a.own_balance,
    future_balance: a.future_balance ?? 0,
    last_entry_date: a.last_entry_date,
    last_checked: a.last_checked ?? null,
    icon: a.icon,
    color: a.color,
    hidden: a.hidden
  }));
}

export async function updateAccount(id: string, patch: Partial<Pick<AccountNode, 'icon' | 'color' | 'name' | 'type' | 'subtype' | 'parent_id' | 'hidden' | 'last_checked'>>): Promise<void> {
  const response = await fetch(`${API_URL}/accounts?id=eq.${id}`, {
    method: 'PATCH',
    headers: getHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to update account');
  }
}

export async function markAccountChecked(id: string): Promise<void> {
  await updateAccount(id, { last_checked: new Date().toISOString() });
}

export async function createAccount(data: { name: string; type: string; subtype?: string | null; parent_id?: string | null; icon?: string | null; color?: string | null; hidden?: boolean }): Promise<AccountNode> {
  const response = await fetch(`${API_URL}/accounts`, {
    method: 'POST',
    headers: getHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to create account');
  }
  const rows = await response.json();
  return rows[0];
}

export async function deleteAccount(id: string): Promise<void> {
  const response = await fetch(`${API_URL}/accounts?id=eq.${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to delete account');
  }
}

export interface AccountAlias {
  alias: string;
  account_id: string;
}

export async function fetchAliases(accountId: string): Promise<AccountAlias[]> {
  const response = await fetch(`${API_URL}/account_aliases?account_id=eq.${accountId}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch aliases');
  }
  return response.json();
}

export async function createAlias(alias: string, accountId: string): Promise<void> {
  const response = await fetch(`${API_URL}/account_aliases`, {
    method: 'POST',
    headers: getHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({ alias, account_id: accountId }),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to create alias');
  }
}

export async function deleteAlias(alias: string): Promise<void> {
  const response = await fetch(`${API_URL}/account_aliases?alias=eq.${encodeURIComponent(alias)}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to delete alias');
  }
}

/**
 * Fetches the exchange rate from Frankfurter.
 * Returns how many units of baseCurrency equal 1 unit of fromCurrency.
 * e.g. fetchExchangeRate('2025-03-25', 'USD', 'BRL') → 5.2  (1 USD = 5.2 BRL)
 */
export async function fetchExchangeRate(
  date: string,
  fromCurrency: string,
  baseCurrency: string
): Promise<number> {
  if (fromCurrency === baseCurrency) return 1.0;
  const url = `https://api.frankfurter.dev/v2/rates?date=${date}&base=${fromCurrency}&quotes=${baseCurrency}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch exchange rate for ${fromCurrency}/${baseCurrency}`);
  const data = await response.json();
  const rate = Array.isArray(data) ? data[0]?.rate : data.rates?.[baseCurrency];
  if (!rate) throw new Error(`Exchange rate not found for ${fromCurrency}/${baseCurrency} on ${date}`);
  return rate;
}

export interface BudgetPlan {
  id: string;
  name: string;
  period_start: string;
  period_end: string;
  is_current: boolean;
  created_at: string;
}

export interface BudgetItemWithAccount {
  id: string;
  plan_id: string;
  account_id: string;
  account_full_name: string;
  account_name: string;
  icon: string | null;
  color: string | null;
  parent_id: string | null;
  period_amount: number;
  min_pct: number;
  max_pct: number;
  sort_order: number;
  category_type: 'yearly' | 'monthly';
}

export interface BudgetPeriodTotal {
  plan_id: string;
  month: string;
  total_spent: number;
}

export interface BudgetMonthlySpending {
  plan_id: string;
  account_id: string;
  month: string;
  spent: number;
}

export async function fetchCurrentBudgetPlan(): Promise<BudgetPlan | null> {
  const response = await fetch(`${API_URL}/budget_plans?is_current=eq.true`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch current budget plan');
  }
  const data: BudgetPlan[] = await response.json();
  return data[0] ?? null;
}

export async function fetchBudgetItems(planId: string): Promise<BudgetItemWithAccount[]> {
  const response = await fetch(`${API_URL}/budget_items_with_accounts?plan_id=eq.${planId}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch budget items');
  }
  return response.json();
}

export async function fetchBudgetMonthlySpending(planId: string): Promise<BudgetMonthlySpending[]> {
  const response = await fetch(`${API_URL}/budget_monthly_spending?plan_id=eq.${planId}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch budget monthly spending');
  }
  return response.json();
}

export async function fetchAllBudgetPlans(): Promise<BudgetPlan[]> {
  const response = await fetch(`${API_URL}/budget_plans?order=created_at.desc`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch budget plans');
  }
  return response.json();
}

export async function createBudgetPlan(name: string, periodStart: string, periodEnd: string): Promise<BudgetPlan> {
  const response = await fetch(`${API_URL}/rpc/create_budget_plan`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_name: name, p_period_start: periodStart, p_period_end: periodEnd }),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to create budget plan');
  }
  return response.json();
}

export async function setCurrentBudgetPlan(planId: string): Promise<void> {
  const response = await fetch(`${API_URL}/rpc/set_current_budget_plan`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_plan_id: planId }),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to set current budget plan');
  }
}

export async function upsertBudgetItem(
  planId: string,
  accountId: string,
  periodAmount: number,
  minPct: number,
  maxPct: number,
  sortOrder = 0,
  categoryType: 'yearly' | 'monthly' = 'yearly',
): Promise<void> {
  const response = await fetch(`${API_URL}/rpc/upsert_budget_item`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_plan_id: planId,
      p_account_id: accountId,
      p_period_amount: periodAmount,
      p_min_pct: minPct,
      p_max_pct: maxPct,
      p_sort_order: sortOrder,
      p_category_type: categoryType,
    }),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to upsert budget item');
  }
}

export async function fetchBudgetPeriodTotals(planId: string): Promise<BudgetPeriodTotal[]> {
  const response = await fetch(`${API_URL}/budget_period_totals?plan_id=eq.${planId}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch budget period totals');
  }
  return response.json();
}

export async function deleteBudgetItem(id: string): Promise<void> {
  const response = await fetch(`${API_URL}/rpc/delete_budget_item`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: id }),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to delete budget item');
  }
}

export interface CategoryMonthlyHistory {
  month: string;  // YYYY-MM-DD
  spent: number;
}

export async function fetchCategoryMonthlyHistory(
  accountId: string,
  months = 13,
): Promise<CategoryMonthlyHistory[]> {
  const response = await fetch(`${API_URL}/rpc/get_category_monthly_history`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_account_id: accountId, p_months: months }),
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error('Failed to fetch category monthly history');
  }
  return response.json();
}
