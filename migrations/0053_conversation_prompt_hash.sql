-- Migration 0053: remember which instructions/tools a conversation's Claude session last saw
--
-- A resumed session keeps its earlier context, including what it believed its tools could do. When
-- the daemon ships a new prompt or new tools, the next turn in an old conversation tells the
-- assistant that its capabilities changed, so it re-reads the tool descriptions instead of
-- answering from memory. The daemon compares this hash with the current one.

ALTER TABLE advisor_conversations ADD COLUMN IF NOT EXISTS prompt_hash TEXT;

NOTIFY pgrst, 'reload schema';
