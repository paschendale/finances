-- Entries definition
CREATE TABLE IF NOT EXISTS entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id),
    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate NUMERIC NOT NULL DEFAULT 1.0,
    amount_base NUMERIC NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Index by transaction for faster transaction details
CREATE INDEX idx_entries_transaction_id ON entries (transaction_id);

-- Index by account for faster balance calculation
CREATE INDEX idx_entries_account_id ON entries (account_id);
