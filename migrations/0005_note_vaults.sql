ALTER TABLE notes ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_notes_vault_updated_at
ON notes(vault_id, updated_at DESC);
