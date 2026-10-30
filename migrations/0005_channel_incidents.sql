-- The problem register of the Диагностика page: one row per incident, a run
-- of one kind of problem on one channel seen by the stream gateway (provider
-- errors, a frozen or slow playlist, players that buffer or cannot open it).
-- The id is generated in memory so the periodic flushes are upserts, like
-- watch_sessions. A channel stays in the register until the admin marks it
-- fixed, which sets cleared_at on its rows (undoable); cleared rows are
-- pruned after STATS_RETENTION_DAYS.

CREATE TABLE channel_incidents (
    id           TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    channel_name TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL,
    detail       TEXT NOT NULL DEFAULT '',
    peak         BIGINT NOT NULL DEFAULT 0,
    user_ids     BIGINT[] NOT NULL DEFAULT '{}',
    started_at   TIMESTAMPTZ NOT NULL,
    ended_at     TIMESTAMPTZ NOT NULL,
    cleared_at   TIMESTAMPTZ
);

CREATE INDEX channel_incidents_uncleared ON channel_incidents (channel_id) WHERE cleared_at IS NULL;
CREATE INDEX channel_incidents_cleared_at ON channel_incidents (cleared_at) WHERE cleared_at IS NOT NULL;
