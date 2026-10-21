-- Viewing history for the statistics page: one row per uninterrupted watch of
-- one channel by one device, written by the stream gateway's recorder. The id
-- is generated in memory so the recorder's periodic flushes are upserts.
-- `channel_name` is the name at the time, so history survives renames and
-- deleted channels. Rows older than STATS_RETENTION_DAYS are pruned.

CREATE TABLE watch_sessions (
    id           TEXT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id   TEXT NOT NULL,
    channel_name TEXT NOT NULL DEFAULT '',
    player       TEXT NOT NULL DEFAULT '',
    ip           TEXT NOT NULL DEFAULT '',
    started_at   TIMESTAMPTZ NOT NULL,
    ended_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX watch_sessions_ended_at ON watch_sessions (ended_at);
CREATE INDEX watch_sessions_user_ended_at ON watch_sessions (user_id, ended_at);
