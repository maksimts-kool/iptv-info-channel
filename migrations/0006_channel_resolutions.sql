-- Channels leave the problem register on their own once the server has
-- shown they work (checks at the provider, customers watching without
-- trouble), not when the admin marks them fixed. Each way out is recorded
-- here for the "Решены" list; the incidents it covered get cleared_at =
-- resolved_at, and both are pruned after STATS_RETENTION_DAYS.

CREATE TABLE channel_resolutions (
    id           TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    channel_name TEXT NOT NULL DEFAULT '',
    kinds        TEXT[] NOT NULL DEFAULT '{}',
    incidents    BIGINT NOT NULL DEFAULT 0,
    user_ids     BIGINT[] NOT NULL DEFAULT '{}',
    first_at     TIMESTAMPTZ NOT NULL,
    last_at      TIMESTAMPTZ NOT NULL,
    resolved_at  TIMESTAMPTZ NOT NULL,
    how          TEXT NOT NULL,
    probes       INTEGER NOT NULL DEFAULT 0,
    viewing_ms   BIGINT NOT NULL DEFAULT 0,
    viewers      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX channel_resolutions_resolved_at ON channel_resolutions (resolved_at);
CREATE INDEX channel_resolutions_channel ON channel_resolutions (channel_id, resolved_at);

-- Restarting a channel is no longer a problem at all.
DELETE FROM channel_incidents WHERE kind = 'retunes';

-- What one customer's player reported is no longer the channel's problem.
UPDATE channel_incidents SET cleared_at = now()
WHERE cleared_at IS NULL AND kind IN ('buffering', 'player') AND cardinality(user_ids) < 2;
