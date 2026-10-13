-- A personal link is how one person reaches their own account from another
-- machine. It is deliberately not an invite: an invite creates a member, this
-- opens a session for a user who already exists.
--
-- One row per user, so minting a new link is also how the previous one is
-- revoked. Only the hash is stored, like every other token here.
CREATE TABLE account_links (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  office_id  INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
