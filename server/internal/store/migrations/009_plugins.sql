-- Plugins: which installed plugins an administrator enabled, and each plugin's key-value data.
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
