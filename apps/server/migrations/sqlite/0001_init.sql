-- Bullpane — SQLite schema, the zero-setup default when DATABASE_URL is unset.
--
-- This is the MySQL schema as of migrations/mysql/0008, created in one go: a
-- SQLite install has no history to replay. The reasoning behind each table and
-- column lives in the MySQL migration that introduced it; this file only notes
-- where SQLite differs.
--
-- Type mapping (see src/db/schema.sqlite.ts): DATETIME(3) → INTEGER epoch ms,
-- TINYINT(1) → INTEGER 0/1, JSON → TEXT, ENUM/VARCHAR → TEXT with a CHECK where
-- MySQL had an ENUM. Foreign keys are declared for documentation; the services
-- delete child rows explicitly, so nothing depends on them being enforced.

CREATE TABLE IF NOT EXISTS users (
  id TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_login_at INTEGER NULL,
  disabled_at INTEGER NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  auth_method TEXT NOT NULL DEFAULT 'password'
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS sso_providers (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  secret_enc TEXT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS sso_providers_enabled_idx ON sso_providers (enabled);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT 'bull',
  cluster INTEGER NOT NULL DEFAULT 0,
  queue_filter TEXT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NULL,
  parent_id TEXT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders (parent_id);

CREATE TABLE IF NOT EXISTS folder_queues (
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  PRIMARY KEY (folder_id, connection_id, queue_name)
);

CREATE TABLE IF NOT EXISTS hidden_queues (
  connection_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  hidden_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  hidden_by TEXT NULL,
  PRIMARY KEY (connection_id, queue_name)
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  scope_type TEXT NOT NULL DEFAULT 'queue' CHECK (scope_type IN ('queue', 'folder', 'connection', 'global')),
  connection_id TEXT NULL,
  queue_name TEXT NULL,
  folder_id TEXT NULL,
  "condition" TEXT NOT NULL,
  channels TEXT NOT NULL,
  cooldown_minutes INTEGER NOT NULL DEFAULT 30,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_fired_at INTEGER NULL,
  firing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_connection_id_idx ON alerts (connection_id);
CREATE INDEX IF NOT EXISTS alerts_folder_id_idx ON alerts (folder_id);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT NOT NULL PRIMARY KEY,
  alert_id TEXT NOT NULL,
  alert_name TEXT NOT NULL,
  connection_id TEXT NULL,
  queue_name TEXT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  value REAL NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS alert_events_created_at_idx ON alert_events (created_at);
CREATE INDEX IF NOT EXISTS alert_events_alert_id_idx ON alert_events (alert_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT NOT NULL PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  actor_id TEXT NULL,
  actor_email TEXT NULL,
  actor_name TEXT NULL,
  actor_role TEXT NULL,
  action TEXT NOT NULL,
  connection_id TEXT NULL,
  connection_name TEXT NULL,
  queue_name TEXT NULL,
  job_id TEXT NULL,
  result TEXT NOT NULL DEFAULT 'ok',
  error_message TEXT NULL,
  detail TEXT NULL,
  ip TEXT NULL,
  user_agent TEXT NULL
);
-- Keyset paging on (created_at, id), newest first — same index as MySQL.
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at, id);
CREATE INDEX IF NOT EXISTS audit_log_actor_id_idx ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS audit_log_queue_idx ON audit_log (connection_id, queue_name);

CREATE TABLE IF NOT EXISTS flow_edges (
  id TEXT NOT NULL PRIMARY KEY,
  connection_id TEXT NOT NULL,
  from_queue TEXT NOT NULL,
  to_queue TEXT NOT NULL,
  label TEXT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_edges_unique ON flow_edges (connection_id, from_queue, to_queue);

CREATE TABLE IF NOT EXISTS settings (
  "key" TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);

-- The starting alert rule from migrations/mysql/0008_alert_wide_scopes.sql.
INSERT INTO alerts (id, name, enabled, scope_type, connection_id, queue_name, folder_id, "condition", channels, cooldown_minutes, created_at, last_fired_at, firing)
SELECT 'default-failure-rate', 'Failure rate above 10%', 1, 'global', NULL, NULL, NULL,
       json_object('kind', 'failed_rate_above', 'percent', 10, 'windowMinutes', 15, 'minSample', 20),
       json_array(), 30, CAST(unixepoch('subsec') * 1000 AS INTEGER), NULL, 0
WHERE NOT EXISTS (SELECT 1 FROM alerts);
