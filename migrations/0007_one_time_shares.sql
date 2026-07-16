-- One-time shares contain only client-encrypted payloads. Raw bearer tokens
-- and decryption-key proofs are hashed again before they reach D1.
CREATE TABLE IF NOT EXISTS note_shares (
  token_hash TEXT PRIMARY KEY,
  proof_hash TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_shares_expires_at
ON note_shares(expires_at);
