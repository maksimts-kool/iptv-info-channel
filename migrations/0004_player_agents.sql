-- Player identification for the statistics. A stream request's User-Agent is
-- often the platform's media stack (samsung-agent, a WebView's Mozilla/5.0),
-- not the IPTV app; the app is whoever downloaded the playlist, whose
-- User-Agent is hashed into the device tag of every gate URL. This remembers
-- the User-Agent behind each tag, so watches are named after the app.

CREATE TABLE player_agents (
    tag        TEXT PRIMARY KEY,
    user_agent TEXT NOT NULL,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The stream request's own User-Agent, shown next to the player name.
ALTER TABLE watch_sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';

-- History recorded before this stored the first User-Agent token: give it the
-- labels new watches get.
UPDATE watch_sessions SET player = CASE lower(player)
    WHEN 'ott-play' THEN 'OTT Play'
    WHEN 'samsung-agent' THEN 'Samsung TV'
    WHEN 'mozilla' THEN 'Браузер'
    WHEN 'exoplayerlib' THEN 'Android'
    WHEN 'okhttp' THEN 'Android'
    WHEN 'dalvik' THEN 'Android'
    WHEN 'lavf' THEN 'FFmpeg'
    WHEN 'libvlc' THEN 'VLC'
    ELSE player
END;
