-- Flow maps (Pro): named diagrams of the queues one process goes through.
--
-- WHY NOT THE FOLDERS: a folder says whose a queue is (Payments, Notifications);
-- a flow says where work goes (checkout → payment-capture → email-send | pick-pack),
-- and one process crosses several folders. A queue belongs to one folder but
-- appears in many flows, so a map REFERENCES queues instead of owning them.
--
-- Maps nest like folders (parent_id, optional). Each map has its own diagram;
-- a parent does not merge its children's.
--
-- A node is connection + queue, so a map may span connections. No FK to
-- connections: queues are discovered strings, not rows, and
-- ConnectionsService.remove() deletes a connection's nodes and edges itself.
-- x/y are the positions the team dragged (NULL = never placed: auto layout).
--
-- Detected maps (FlowProducer) are computed from Redis and never stored.

CREATE TABLE IF NOT EXISTS flow_maps (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(500) NULL,
  parent_id VARCHAR(36) NULL,
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY flow_maps_parent_id_idx (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_map_nodes (
  map_id VARCHAR(36) NOT NULL,
  connection_id VARCHAR(36) NOT NULL,
  queue_name VARCHAR(255) NOT NULL,
  x DOUBLE NULL,
  y DOUBLE NULL,
  PRIMARY KEY (map_id, connection_id, queue_name),
  KEY flow_map_nodes_connection_idx (connection_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_map_edges (
  id VARCHAR(36) NOT NULL,
  map_id VARCHAR(36) NOT NULL,
  from_connection_id VARCHAR(36) NOT NULL,
  from_queue VARCHAR(255) NOT NULL,
  to_connection_id VARCHAR(36) NOT NULL,
  to_queue VARCHAR(255) NOT NULL,
  label VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY flow_map_edges_unique (map_id, from_connection_id, from_queue, to_connection_id, to_queue),
  KEY flow_map_edges_from_conn_idx (from_connection_id),
  KEY flow_map_edges_to_conn_idx (to_connection_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
