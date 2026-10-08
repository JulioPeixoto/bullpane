-- Flow maps (Pro). Same tables as migrations/mysql/0011_flow_maps.sql, which
-- explains the design.

CREATE TABLE IF NOT EXISTS flow_maps (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NULL,
  parent_id TEXT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS flow_maps_parent_id_idx ON flow_maps (parent_id);

CREATE TABLE IF NOT EXISTS flow_map_nodes (
  map_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  x REAL NULL,
  y REAL NULL,
  PRIMARY KEY (map_id, connection_id, queue_name)
);
CREATE INDEX IF NOT EXISTS flow_map_nodes_connection_idx ON flow_map_nodes (connection_id);

CREATE TABLE IF NOT EXISTS flow_map_edges (
  id TEXT NOT NULL PRIMARY KEY,
  map_id TEXT NOT NULL,
  from_connection_id TEXT NOT NULL,
  from_queue TEXT NOT NULL,
  to_connection_id TEXT NOT NULL,
  to_queue TEXT NOT NULL,
  label TEXT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_map_edges_unique ON flow_map_edges (map_id, from_connection_id, from_queue, to_connection_id, to_queue);
CREATE INDEX IF NOT EXISTS flow_map_edges_from_conn_idx ON flow_map_edges (from_connection_id);
CREATE INDEX IF NOT EXISTS flow_map_edges_to_conn_idx ON flow_map_edges (to_connection_id);
