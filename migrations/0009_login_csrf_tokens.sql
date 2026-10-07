-- One-time native login form tokens allow browsers that omit Origin to
-- authenticate without accepting a cross-site form post.
CREATE TABLE IF NOT EXISTS login_csrf_tokens (
  token_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_csrf_tokens_expires_at
ON login_csrf_tokens(expires_at);