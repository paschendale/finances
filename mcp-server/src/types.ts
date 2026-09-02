export interface Env {
  POSTGREST_URL: string;
}

export interface ToolCtx {
  rawToken: string;
  env: Env;
}

export interface Entry {
  id?: string;
  account_id: string;
  amount: number;
  currency: string;
  exchange_rate: number;
  amount_base: number;
}

export interface Transaction {
  id: string;
  date: string;
  description: string;
  metadata?: Record<string, unknown>;
  entries: Entry[];
}
