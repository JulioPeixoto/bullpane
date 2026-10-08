-- Alert rules can now cover every queue on one connection, or every queue on
-- every connection. They are also what drives "Needs attention" on the
-- Overview in Pro, so a rule with no channels (dashboard only) is valid.
--
-- `connection` reuses connection_id with queue_name NULL; `global` uses no
-- column at all. Hidden queues are excluded from both at evaluation time.
ALTER TABLE alerts MODIFY scope_type ENUM('queue','folder','connection','global') NOT NULL DEFAULT 'queue';

-- One starting rule, so the Overview has something to say on day one:
-- failure rate above 10% over 15 minutes on any queue with at least 20
-- finished jobs, measured from BullMQ metrics, notifying nobody. Only
-- inserted when the install has no alerts yet; edit or delete it freely.
INSERT INTO alerts (id, name, enabled, scope_type, connection_id, queue_name, folder_id, `condition`, channels, cooldown_minutes, created_at, last_fired_at, firing)
SELECT 'default-failure-rate', 'Failure rate above 10%', 1, 'global', NULL, NULL, NULL,
       JSON_OBJECT('kind', 'failed_rate_above', 'percent', 10, 'windowMinutes', 15, 'minSample', 20),
       JSON_ARRAY(), 30, UTC_TIMESTAMP(3), NULL, 0
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM alerts);
