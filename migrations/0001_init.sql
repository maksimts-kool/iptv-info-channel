-- Initial schema: everything that used to live in db.json and catalog.json.
--
-- Calendar days (subscription expiry, incident spans) are DATE; instants are
-- TIMESTAMPTZ. Free-form shapes that the admin UI owns (playlist attributes,
-- notification topics, newsletter audiences, provider-news state) are JSONB.

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- A plan IS a channel package: `category_ids` are the catalog categories it
-- sells (not a foreign key: a deleted category is simply never matched).
CREATE TABLE plans (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    price_cents    BIGINT NOT NULL DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'EUR',
    billing_period TEXT NOT NULL DEFAULT '' CHECK (billing_period IN ('', 'month', 'year')),
    sort           DOUBLE PRECISION NOT NULL DEFAULT 0,
    category_ids   TEXT[] NOT NULL DEFAULT '{}',
    max_devices    BIGINT NOT NULL DEFAULT 0 CHECK (max_devices >= 0),
    extra          JSONB NOT NULL DEFAULT '{}'
);

-- Customers. `token` is the stream capability; `notify_token` the separate
-- token behind the on-screen sign-up QR. Keep the two namespaces apart.
CREATE TABLE users (
    id           BIGSERIAL PRIMARY KEY,
    username     TEXT NOT NULL,
    token        TEXT NOT NULL UNIQUE,
    notify_token TEXT NOT NULL UNIQUE,
    plan_id      TEXT NOT NULL DEFAULT '',
    expires_at   DATE,
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    max_devices  BIGINT CHECK (max_devices IS NULL OR max_devices >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra        JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE incidents (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    severity   TEXT NOT NULL CHECK (severity IN ('degraded', 'outage')),
    starts_on  DATE,
    ends_on    DATE,
    note       TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One email subscription per customer, double opt-in.
CREATE TABLE subscribers (
    user_id            BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    email              TEXT NOT NULL,
    options            JSONB NOT NULL DEFAULT '{}',
    verified           BOOLEAN NOT NULL DEFAULT FALSE,
    verify_token       TEXT UNIQUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_expiry_notice DATE
);

-- Capped ring buffer of sends (trimmed by the app).
CREATE TABLE notify_log (
    id      BIGSERIAL PRIMARY KEY,
    at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id BIGINT,
    email   TEXT NOT NULL DEFAULT '',
    kind    TEXT NOT NULL DEFAULT '',
    ok      BOOLEAN NOT NULL,
    error   TEXT
);

-- The payments ledger. Name and plan are snapshotted, so a row survives a
-- rename or a deleted customer (hence no foreign key on user_id).
CREATE TABLE payments (
    seq                 BIGSERIAL UNIQUE,
    id                  TEXT PRIMARY KEY,
    at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id             BIGINT NOT NULL,
    username            TEXT NOT NULL DEFAULT '',
    plan_id             TEXT NOT NULL DEFAULT '',
    plan_name           TEXT NOT NULL DEFAULT '',
    count               BIGINT NOT NULL DEFAULT 1,
    period              TEXT NOT NULL DEFAULT '',
    "from"              TEXT NOT NULL DEFAULT '',
    previous_expires_at DATE,
    expires_at          DATE,
    amount_cents        BIGINT,
    currency            TEXT NOT NULL DEFAULT 'EUR',
    note                TEXT NOT NULL DEFAULT ''
);
CREATE INDEX payments_user ON payments (user_id, seq);

CREATE TABLE newsletters (
    seq        BIGSERIAL UNIQUE,
    id         TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    subject    TEXT NOT NULL,
    body       TEXT NOT NULL,
    important  BOOLEAN NOT NULL DEFAULT FALSE,
    audience   JSONB,
    status     TEXT NOT NULL DEFAULT 'sent',
    recipients BIGINT NOT NULL DEFAULT 0,
    sent       BIGINT NOT NULL DEFAULT 0,
    failed     BIGINT NOT NULL DEFAULT 0,
    error      TEXT,
    sent_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Channel catalog
-- ---------------------------------------------------------------------------

CREATE TABLE sources (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    url            TEXT NOT NULL,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    auto_refresh   BOOLEAN NOT NULL DEFAULT TRUE,
    interval_hours DOUBLE PRECISION,
    epg_url        TEXT NOT NULL DEFAULT '',
    last_sync_at   TIMESTAMPTZ,
    last_error     TEXT,
    last_count     BIGINT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL,
    name        TEXT NOT NULL,
    source_name TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    builtin     BOOLEAN NOT NULL DEFAULT FALSE,
    custom      BOOLEAN NOT NULL DEFAULT FALSE,
    sort        BIGINT NOT NULL DEFAULT 0
);

-- Admin edits beat upstream; vanished channels are flagged `missing`, never
-- deleted (a refresh must not destroy overrides). `key` is the per-source
-- identity (tvg-id, else the stream URL).
CREATE TABLE channels (
    id             TEXT PRIMARY KEY,
    key            TEXT NOT NULL,
    source_id      TEXT REFERENCES sources (id) ON DELETE CASCADE,
    category_id    TEXT NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
    name           TEXT NOT NULL DEFAULT '',
    original_name  TEXT NOT NULL DEFAULT '',
    upstream_group TEXT,
    url            TEXT NOT NULL DEFAULT '',
    attrs          JSONB NOT NULL DEFAULT '{}',
    extras         JSONB NOT NULL DEFAULT '[]',
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    builtin        BOOLEAN NOT NULL DEFAULT FALSE,
    custom         BOOLEAN NOT NULL DEFAULT FALSE,
    missing        BOOLEAN NOT NULL DEFAULT FALSE,
    sort           BIGINT NOT NULL DEFAULT 0,
    added_at       TIMESTAMPTZ
);
CREATE INDEX channels_category ON channels (category_id);
CREATE UNIQUE INDEX channels_source_key ON channels (source_id, key) WHERE source_id IS NOT NULL;

-- Sparse per-customer pins: absent = inherit. Not foreign-keyed to the
-- catalog on purpose (a pin may outlive a re-import of the same channel).
CREATE TABLE user_overrides (
    user_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind      TEXT NOT NULL CHECK (kind IN ('category', 'channel')),
    target_id TEXT NOT NULL,
    value     BOOLEAN NOT NULL,
    PRIMARY KEY (user_id, kind, target_id)
);
