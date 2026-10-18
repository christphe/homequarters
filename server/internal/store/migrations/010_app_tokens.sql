-- App tokens: a member's token for one plugin, so an app on their computer (a desktop companion)
-- can call that plugin's routes as them. One per member, plugin and office; only the hash is stored.
CREATE TABLE app_tokens (
  office_id    INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin       TEXT NOT NULL,
  token_hash   BLOB NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (office_id, user_id, plugin)
);
