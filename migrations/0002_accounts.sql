-- Account definition
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'expense', 'income', 'equity')),
    parent_id UUID REFERENCES accounts(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    -- Ensure name is unique under the same parent
    UNIQUE (parent_id, name)
);

-- For root accounts (parent_id IS NULL), the above UNIQUE constraint only works if we handle NULLs.
-- In Postgres, NULL != NULL, so we need a separate constraint or a different approach for roots.
CREATE UNIQUE INDEX idx_accounts_unique_root_name ON accounts (name) WHERE parent_id IS NULL;
