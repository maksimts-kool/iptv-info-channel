//! Which player app a viewer uses, for the statistics.
//!
//! The User-Agent on a stream request is often not the app's own: an IPTV app
//! hands the URL to the platform's media stack (Samsung's `samsung-agent`, an
//! Android `ExoPlayer`/okhttp, a web view's `Mozilla/5.0 …`). The app itself is
//! the one that DOWNLOADED THE PLAYLIST, and that User-Agent is baked into
//! every gate URL as the device tag ([`super::devices::device_tag`]). So a
//! watch is named after the playlist's downloader, with the stream's platform
//! added when it says something ("OTT Play · Samsung TV").

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    /// A media stack that says nothing about the app ("Android", "Браузер").
    Generic,
    /// A device family ("Samsung TV").
    Platform,
    /// A named app, known or not.
    App,
}

/// Case-insensitive User-Agent fragments, checked in order: apps first, so a
/// web view that names its app is that app, then platforms, then stacks.
const KNOWN: &[(&str, &str, Kind)] = &[
    ("ott-play", "OTT Play", Kind::App),
    ("ottplay", "OTT Play", Kind::App),
    ("ott play", "OTT Play", Kind::App),
    ("ott navigator", "OTT Navigator", Kind::App),
    ("ottnavigator", "OTT Navigator", Kind::App),
    ("tivimate", "TiviMate", Kind::App),
    ("kodi", "Kodi", Kind::App),
    ("vlc", "VLC", Kind::App),
    ("smarters", "IPTV Smarters", Kind::App),
    ("perfect player", "Perfect Player", Kind::App),
    ("perfectplayer", "Perfect Player", Kind::App),
    ("ss iptv", "SS IPTV", Kind::App),
    ("ssiptv", "SS IPTV", Kind::App),
    ("televizo", "Televizo", Kind::App),
    ("lazyiptv", "Lazy IPTV", Kind::App),
    ("lazy iptv", "Lazy IPTV", Kind::App),
    ("progtv", "ProgTV", Kind::App),
    ("iptvnator", "IPTVnator", Kind::App),
    ("samsung-agent", "Samsung TV", Kind::Platform),
    ("tizen", "Samsung TV", Kind::Platform),
    ("web0s", "LG TV", Kind::Platform),
    ("webos", "LG TV", Kind::Platform),
    ("netcast", "LG TV", Kind::Platform),
    ("bravia", "Sony TV", Kind::Platform),
    ("appletv", "Apple TV", Kind::Platform),
    ("applecoremedia", "Apple", Kind::Platform),
    ("smart-tv", "Smart TV", Kind::Platform),
    ("smarttv", "Smart TV", Kind::Platform),
    ("exoplayer", "Android", Kind::Generic),
    ("okhttp", "Android", Kind::Generic),
    ("dalvik", "Android", Kind::Generic),
    ("lavf", "FFmpeg", Kind::Generic),
    ("mozilla", "Браузер", Kind::Generic),
];

fn classify(user_agent: &str) -> Option<(String, Kind)> {
    let ua = user_agent.trim();
    if ua.is_empty() {
        return None;
    }
    let lower = ua.to_lowercase();
    if let Some((_, label, kind)) = KNOWN.iter().find(|(needle, ..)| lower.contains(needle)) {
        return Some(((*label).to_owned(), *kind));
    }
    // Unknown: the product token ("MyPlayer/2.1 (…)" -> "MyPlayer").
    let first = ua.split([' ', '(', '/']).next().unwrap_or("").trim();
    (!first.is_empty()).then(|| (first.chars().take(40).collect(), Kind::App))
}

/// Name a watch: the app that downloaded the playlist (`app_agent`) when it
/// is known, plus the platform the stream request came from.
pub fn describe_player(app_agent: Option<&str>, stream_agent: &str) -> String {
    let stream = classify(stream_agent);
    let app = app_agent.and_then(classify);
    match (app, stream) {
        (Some((app, Kind::App)), Some((platform, Kind::Platform))) => format!("{app} · {platform}"),
        (Some((app, app_kind)), Some((stream, stream_kind))) => {
            if app_kind >= stream_kind {
                app
            } else {
                stream
            }
        }
        (Some((label, _)), None) | (None, Some((label, _))) => label,
        (None, None) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player_label(user_agent: &str) -> String {
        classify(user_agent).map(|(label, _)| label).unwrap_or_default()
    }

    #[test]
    fn labels() {
        assert_eq!(player_label("OTT-play/1.6.2 (Linux; Android 11)"), "OTT Play");
        assert_eq!(player_label("samsung-agent/1.1"), "Samsung TV");
        assert_eq!(player_label("TiviMate/4.7.0 (Linux; Android 11)"), "TiviMate");
        assert_eq!(player_label("VLC/3.0.20 LibVLC/3.0.20"), "VLC");
        assert_eq!(player_label("ExoPlayerLib/2.18.1"), "Android");
        assert_eq!(
            player_label("Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36"),
            "Samsung TV"
        );
        assert_eq!(
            player_label("Mozilla/5.0 (X11; Fedora; Linux x86_64) AppleWebKit/537.36 Chrome/131.0"),
            "Браузер"
        );
        assert_eq!(player_label("MyPlayer/2.1 (Linux)"), "MyPlayer");
        assert_eq!(player_label(""), "");
    }

    #[test]
    fn the_playlist_app_names_the_watch() {
        assert_eq!(
            describe_player(Some("OTT-play/1.6.2"), "samsung-agent/1.1"),
            "OTT Play · Samsung TV"
        );
        assert_eq!(
            describe_player(
                Some("OTT Navigator/1.7.1.4 (Linux;Android 13)"),
                "Mozilla/5.0 (X11; Linux x86_64)"
            ),
            "OTT Navigator"
        );
        assert_eq!(describe_player(Some("OTT-play/1.6.2"), "OTT-play/1.6.2"), "OTT Play");
        // A generic downloader does not hide a named stream player.
        assert_eq!(describe_player(Some("okhttp/4.9.3"), "TiviMate/4.7.0"), "TiviMate");
        assert_eq!(describe_player(None, "samsung-agent/1.1"), "Samsung TV");
        assert_eq!(describe_player(Some("OTT-play/1.6.2"), ""), "OTT Play");
        assert_eq!(describe_player(None, ""), "");
    }
}
