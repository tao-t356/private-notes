-- Timed shares remain readable until expiry; legacy rows keep one-time semantics.
ALTER TABLE note_shares
ADD COLUMN share_mode TEXT NOT NULL DEFAULT 'one_time';