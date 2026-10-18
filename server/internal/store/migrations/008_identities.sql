-- An identity is how a sign-in provider (Google, ...) names a person: the
-- provider's stable subject, never the email, which can change hands. With
-- HQ_AUTH_PROVIDERS set, a member reaches the office only through one.
--
-- One identity per provider and user: a member is one Google account. The
-- email is kept for administrators to recognise who is who; it is never logged.
CREATE TABLE identities (
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);
