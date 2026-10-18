-- Plugins: which plugins an administrator enabled and how they set them up, each plugin's key-value
-- data, and members' app tokens.
-- The plugins themselves are folders on disk (HQ_PLUGINS_DIR); nothing of their code is stored.
CREATE TABLE plugins (
  office_id  INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (office_id, name)
);

CREATE TABLE plugin_kv (
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  plugin    TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (office_id, plugin, key)
);

-- An administrator's settings of a plugin (declared in its plugin.json), whole numbers for now.
CREATE TABLE plugin_settings (
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  plugin    TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     REAL NOT NULL,
  PRIMARY KEY (office_id, plugin, key)
);

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
