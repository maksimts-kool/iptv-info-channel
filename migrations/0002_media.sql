-- The media channel: articles (rich TipTap documents) shown in order, and the
-- uploaded images/videos they embed (files under DATA_DIR/media).

CREATE TABLE media_articles (
    id           TEXT PRIMARY KEY,
    position     BIGINT NOT NULL DEFAULT 0,
    title        TEXT NOT NULL DEFAULT '',
    doc          JSONB NOT NULL,
    seconds      BIGINT NOT NULL DEFAULT 15,
    scroll_speed BIGINT NOT NULL DEFAULT 40,
    -- NULL = every customer; otherwise { users, plans }.
    audience     JSONB,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An asset belongs to the article it was uploaded into, but is NOT foreign-
-- keyed to it: the app decides when its files go (an image pasted into
-- another article must survive its first article's deletion).
CREATE TABLE media_assets (
    id            TEXT PRIMARY KEY,
    article_id    TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'processing', 'error')),
    error         TEXT,
    file          TEXT,
    thumb         TEXT,
    width         BIGINT NOT NULL DEFAULT 0,
    height        BIGINT NOT NULL DEFAULT 0,
    duration      DOUBLE PRECISION NOT NULL DEFAULT 0,
    has_audio     BOOLEAN NOT NULL DEFAULT FALSE,
    size          BIGINT NOT NULL DEFAULT 0,
    original_name TEXT NOT NULL DEFAULT '',
    enc           TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
