-- MCP (Pro): OAuth clients, single-use authorization codes and grants.
-- Same tables as migrations/mysql/0009_mcp.sql, which explains the design
-- (why there is no access-token table, why codes and refresh tokens are hashes).

CREATE TABLE IF NOT EXISTS mcp_clients (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_clients_created_at_idx ON mcp_clients (created_at);

CREATE TABLE IF NOT EXISTS mcp_auth_codes (
  code_hash TEXT NOT NULL PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_auth_codes_expires_at_idx ON mcp_auth_codes (expires_at);

CREATE TABLE IF NOT EXISTS mcp_grants (
  id TEXT NOT NULL PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  -- the refresh token this one replaced; seeing it again = reuse = revoke
  prev_refresh_hash TEXT NULL,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_grants_refresh_hash_unique ON mcp_grants (refresh_hash);
CREATE INDEX IF NOT EXISTS mcp_grants_prev_refresh_hash_idx ON mcp_grants (prev_refresh_hash);
CREATE INDEX IF NOT EXISTS mcp_grants_user_id_idx ON mcp_grants (user_id);
