-- Encrypted fields cannot be meaningfully indexed by FTS. Remove the unused
-- plaintext-search structures and let migrations be the only schema owner.
DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_au;
DROP TRIGGER IF EXISTS notes_ad;
DROP TABLE IF EXISTS notes_fts;

DROP INDEX IF EXISTS idx_notes_updated_at;
DROP INDEX IF EXISTS idx_notes_vault_updated_at;

-- Supports stable per-vault keyset pagination by (updated_at, id).
CREATE INDEX IF NOT EXISTS idx_notes_vault_updated_id
ON notes(vault_id, updated_at DESC, id DESC);
