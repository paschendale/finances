-- Table for description-based memory
CREATE TABLE IF NOT EXISTS description_memories (
    description TEXT PRIMARY KEY,
    category_id UUID REFERENCES accounts(id),
    account_id UUID REFERENCES accounts(id),
    currency TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Table for global settings (last used account/currency)
CREATE TABLE IF NOT EXISTS global_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- View for easier consumption
CREATE OR REPLACE VIEW description_memories_with_names AS
SELECT 
    m.description,
    m.category_id,
    c.name as category_name,
    m.account_id,
    a.name as account_name,
    m.currency,
    m.updated_at
FROM description_memories m
LEFT JOIN accounts c ON m.category_id = c.id
LEFT JOIN accounts a ON m.account_id = a.id;
