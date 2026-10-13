//! Pure logic for the upstream provider's news feed (tv.team `/v3/news`): turn
//! the feed's HTML items into short service notices for the status slide, and
//! keep the provider's session cookie jar current. No I/O.
//!
//! Only notices about the provider's SERVICE are kept — maintenance, outages,
//! channels temporarily unavailable. Channel launches and removals are news,
//! not status, and must never reach the status board ([`is_service_notice`]).

use indexmap::IndexMap;
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::util::{iso, local_time_to_timestamp, parse_instant};
use crate::{fancy_regex, regex};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeKind {
    Maintenance,
    #[default]
    Outage,
}

impl NoticeKind {
    /// Short label shown on the slide and in the admin.
    pub fn label(self) -> &'static str {
        match self {
            Self::Maintenance => "Технические работы",
            Self::Outage => "Перебои в работе",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderNotice {
    pub id: String,
    pub published_at: String,
    pub kind: NoticeKind,
    pub headline: String,
    pub body: String,
    /// The whole language section, for the AI retelling and the admin.
    #[serde(default)]
    pub text: String,
    /// The body is an AI retelling of `text`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ai: bool,
}

// ---- HTML -> text ----

pub fn decode_entities(text: &str) -> String {
    regex!(r"(?i)&(#x[0-9a-f]+|#\d+|[a-z]+);")
        .replace_all(text, |c: &regex::Captures<'_>| {
            let code = &c[1];
            let decoded = if let Some(num) = code.strip_prefix('#') {
                let n = match num.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => num.parse().ok(),
                };
                n.filter(|n| *n > 0)
                    .and_then(char::from_u32)
                    .map(String::from)
            } else {
                match code.to_lowercase().as_str() {
                    "amp" => Some("&".into()),
                    "lt" => Some("<".into()),
                    "gt" => Some(">".into()),
                    "quot" => Some("\"".into()),
                    "apos" => Some("'".into()),
                    "nbsp" => Some(" ".into()),
                    _ => None,
                }
            };
            decoded.unwrap_or_else(|| c[0].to_owned())
        })
        .into_owned()
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One entry per paragraph/line, tags stripped, entities decoded, blanks dropped.
pub fn html_to_paragraphs(html: &str) -> Vec<String> {
    regex!(r"(?i)</p>|<br\s*/?>|</div>|</li>")
        .split(html)
        .map(|chunk| collapse_ws(&decode_entities(&regex!(r"<[^>]*>").replace_all(chunk, ""))))
        .filter(|s| !s.is_empty())
        .collect()
}

/// The text of one language section ("🇷🇺 RU", "🇬🇧 EN"); the whole text when
/// the item isn't split, the first section when `lang` is missing. The code
/// must be ASCII, so a footer like "🇷🇺 Россия" is not a section marker.
pub fn language_section(text: &str, lang: &str) -> String {
    let re = fancy_regex!(r"[\x{1F1E6}-\x{1F1FF}]{2}\s*([A-Z]{2})(?!\p{L})");
    let marks: Vec<(usize, usize, String)> = re
        .captures_iter(text)
        .filter_map(Result::ok)
        .filter_map(|c| {
            let whole = c.get(0)?;
            Some((whole.start(), whole.end(), c.get(1)?.as_str().to_owned()))
        })
        .collect();
    if marks.is_empty() {
        return text.trim().to_owned();
    }
    let i = marks.iter().position(|m| m.2 == lang).unwrap_or(0);
    let end = marks.get(i + 1).map_or(text.len(), |m| m.0);
    text[marks[i].1..end].trim().to_owned()
}

/// Emoji render as tofu in the SVG rasterizer, so they go.
pub fn strip_emoji(text: &str) -> String {
    let re = fancy_regex!(
        r"[\p{Extended_Pictographic}\x{1F1E6}-\x{1F1FF}\x{1F3FB}-\x{1F3FF}\x{FE0E}\x{FE0F}\x{200D}\x{20E3}]"
    );
    let stripped = re.replace_all(text, "");
    regex!(r" ([!?.,:;])")
        .replace_all(&collapse_ws(&stripped), "$1")
        .trim()
        .to_owned()
}

// ---- Classification ----

fn is_maintenance(t: &str) -> bool {
    fancy_regex!(r"техническ\p{L}* работ|техработ|профилактическ|планов\p{L}* (?:работ|замен|обслуживан|обновлени)|maintenance")
        .is_match(t)
        .unwrap_or(false)
}

fn is_outage(t: &str) -> bool {
    fancy_regex!(
        r"перебо|(?<!\p{L})сбо(?:й|я|ю|е|и|ев|ями|ях)(?!\p{L})|авари|неполадк|недоступн|не работа(?:ет|ют)|нестабильн|проблем\p{L}* (?:с|в) (?:вещани|работ|доступ|сервер|архив|воспроизвед)|восстановлен\p{L}* (?:работ|вещани|доступ)|(?:работ\p{L}*|вещани\p{L}*|доступ) (?:\p{L}+ ){0,3}восстановлен|outage|disruption|temporarily unavailable"
    )
    .is_match(t)
    .unwrap_or(false)
}

/// Matched against the lowercased text of every language.
pub fn is_service_notice(text: &str) -> bool {
    let t = text.to_lowercase();
    is_maintenance(&t) || is_outage(&t)
}

pub fn notice_kind(text: &str) -> NoticeKind {
    if is_maintenance(&text.to_lowercase()) {
        NoticeKind::Maintenance
    } else {
        NoticeKind::Outage
    }
}

pub fn split_sentences(text: &str) -> Vec<String> {
    // Split after sentence punctuation followed by whitespace.
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if matches!(c, '.' | '!' | '?' | '…')
            && let Some(&(j, next)) = chars.peek()
            && next.is_whitespace()
        {
            out.push(text[start..j].trim().to_owned());
            start = j;
            let _ = i;
        }
    }
    out.push(text[start..].trim().to_owned());
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

/// `(headline, body)`: a short exclaimed opener ("Технические работы!")
/// becomes the headline, otherwise the kind label does; apology boilerplate
/// is dropped from the body unless it is all there is.
pub fn summarize_notice(text: &str, kind: NoticeKind) -> (String, String) {
    let mut sentences = split_sentences(text);
    let mut headline = kind.label().to_owned();
    if sentences.len() > 1 && sentences[0].chars().count() <= 48 && !sentences[0].ends_with('.') {
        sentences[0]
            .trim_end_matches(['!', ':', '…'])
            .trim()
            .clone_into(&mut headline);
        sentences.remove(0);
    }
    let boilerplate = regex!(
        r"приносим (?:свои )?извинения|благодарим за (?:ваше )?понимание|спасибо за (?:ваше )?понимание|следите за новостями"
    );
    let meaningful: Vec<&String> = sentences
        .iter()
        .filter(|s| !boilerplate.is_match(&s.to_lowercase()))
        .collect();
    let body = if meaningful.is_empty() {
        sentences.join(" ")
    } else {
        meaningful
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    };
    (headline, body)
}

// ---- Feed parsing ----

/// "14.09.2026 13:06:44" is the provider's wall clock; read it in `tz`.
pub fn parse_provider_date(value: &str, tz: &TimeZone) -> Option<Timestamp> {
    let text = value.trim();
    if let Some(c) =
        regex!(r"^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$").captures(text)
    {
        let n = |i: usize| c.get(i).map_or(Some(0), |m| m.as_str().parse::<i32>().ok());
        let date = Date::new(
            i16::try_from(n(3)?).ok()?,
            i8::try_from(n(2)?).ok()?,
            i8::try_from(n(1)?).ok()?,
        )
        .ok()?;
        return Some(local_time_to_timestamp(
            date,
            i8::try_from(n(4)?).ok()?,
            i8::try_from(n(5)?).ok()?,
            i8::try_from(n(6)?).ok()?,
            tz,
        ));
    }
    if text.is_empty() {
        None
    } else {
        parse_instant(text)
    }
}

/// The service notices in a `/v3/news` response, newest first.
pub fn extract_service_notices(
    json: &Value,
    tz: &TimeZone,
    lang: &str,
    limit: usize,
) -> Vec<ProviderNotice> {
    let items = json
        .pointer("/data/items")
        .or_else(|| json.get("items"))
        .and_then(Value::as_array);
    let mut out: Vec<ProviderNotice> = Vec::new();
    for item in items.into_iter().flatten() {
        if !item.is_object() || item.get("isPublished") == Some(&Value::Bool(false)) {
            continue;
        }
        let html = item
            .get("html")
            .or_else(|| item.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let full = html_to_paragraphs(html).join("\n");
        if full.is_empty() || !is_service_notice(&full) {
            continue;
        }
        let Some(published) = item
            .get("date")
            .and_then(Value::as_str)
            .and_then(|d| parse_provider_date(d, tz))
        else {
            continue;
        };
        let kind = notice_kind(&full);
        let text = strip_emoji(&language_section(&full, lang));
        let (headline, body) = summarize_notice(&text, kind);
        let id = match item.get("id") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => published.as_millisecond().to_string(),
        };
        out.push(ProviderNotice {
            id,
            published_at: iso(published),
            kind,
            headline,
            body,
            text,
            ai: false,
        });
    }
    out.sort_by(|a, b| b.published_at.cmp(&a.published_at));
    out.truncate(limit);
    out
}

/// Notices recent enough to still be on screen. A notice has no end date, so
/// age is the only way one leaves the slide.
pub fn active_notices(
    notices: &[ProviderNotice],
    now: Timestamp,
    max_age_hours: f64,
) -> Vec<ProviderNotice> {
    let cutoff = now.as_millisecond() - (max_age_hours * 3_600_000.0) as i64;
    notices
        .iter()
        .filter(|n| parse_instant(&n.published_at).is_some_and(|t| t.as_millisecond() >= cutoff))
        .cloned()
        .collect()
}

// ---- Session cookie jar ----

/// "a=1; b=2" (optionally pasted with a leading "Cookie:") -> ordered jar.
pub fn parse_cookie_header(header: &str) -> IndexMap<String, String> {
    let text = regex!(r"(?i)^\s*cookie\s*:").replace(header, "");
    let mut jar = IndexMap::new();
    for part in regex!(r";|\r?\n").split(&text) {
        let Some(eq) = part.find('=').filter(|eq| *eq > 0) else {
            continue;
        };
        let name = part[..eq].trim();
        if !name.is_empty() {
            jar.insert(name.to_owned(), part[eq + 1..].trim().to_owned());
        }
    }
    jar
}

pub fn serialize_cookies(jar: &IndexMap<String, String>) -> String {
    jar.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Apply a response's Set-Cookie lines to a Cookie header: a rotated session
/// replaces the old value, an expired/emptied cookie is removed.
pub fn apply_set_cookies(header: &str, set_cookies: &[String], now_ms: i64) -> String {
    let mut jar = parse_cookie_header(header);
    for line in set_cookies {
        let mut parts = line.split(';');
        let pair = parts.next().unwrap_or("");
        let Some(eq) = pair.find('=').filter(|eq| *eq > 0) else {
            continue;
        };
        let name = pair[..eq].trim().to_owned();
        let value = pair[eq + 1..].trim().to_owned();
        let expired = parts.any(|attr| {
            let (key, val) = attr.split_once('=').map_or((attr, ""), |(k, v)| (k, v));
            match key.trim().to_lowercase().as_str() {
                "max-age" => val.trim().parse::<f64>().is_ok_and(|n| n <= 0.0),
                "expires" => jiff::fmt::rfc2822::parse(val.trim())
                    .is_ok_and(|z| z.timestamp().as_millisecond() <= now_ms),
                _ => false,
            }
        });
        if expired || value.is_empty() {
            jar.shift_remove(&name);
        } else {
            jar.insert(name, value);
        }
    }
    serialize_cookies(&jar)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tz() -> TimeZone {
        TimeZone::get("Europe/Tallinn").unwrap()
    }

    fn feed() -> Value {
        json!({ "data": { "items": [
            { "id": 8786, "date": "14.09.2026 13:06:44", "isPublished": true,
              "html": "<p>🇷🇺 RU ⚠️ Технические работы! Сообщаем, что часть телеканалов будет временно недоступна в течение нескольких часов в связи с плановой заменой архивных серверов. Обратите внимание: архивы на затрагиваемых каналах будут формироваться заново с момента завершения работ. Приносим извинения за временные неудобства и благодарим за понимание! 🛠️⚡️</p><p> 🇬🇧 EN ⚠️ Technical Maintenance Alert! Please be advised that some channels will be temporarily unavailable for a few hours due to scheduled archive server replacements. We apologize for any temporary inconvenience and appreciate your understanding! 🛠️⚡️</p>" },
            { "id": 8765, "date": "12.09.2026 18:32:09", "isPublished": true,
              "html": "<p>🇷🇺 RU</p><p>📺 <strong>«TEAM СМЕРШ-ТВ» </strong>с 12 сентября! 🎬</p><p>Круглосуточный канал военно-исторических и криминальных детективов XX века: шпионские и ретро-сериалы («Ликвидация», «Место встречи изменить нельзя» и др.).</p><p>👉 Обновляйте плейлисты! 🔄</p><p>🇬🇧 EN</p><p>📺 <strong>&#34;TEAM SMERSH-TV&#34;</strong> from Sept 12! 🎬</p><p>👉 Update playlists! 🔄</p><p>📂 VIP | 🇷🇺 Россия | 📦 Базовый | ⏱ Повременка</p>" },
            { "id": 8728, "date": "10.09.2026 09:02:34", "isPublished": true,
              "html": "<p>🇷🇺 RU</p><p>ℹ️ <strong>Изменения в пакете «Армения»</strong></p><p>Сообщаем, что каналы Nur и Shant Premium USA завершили свое вещание и были удалены из списков.</p><p>Приносим извинения за неудобства и рекомендуем обновить ваши плейлисты. 📡🔄</p>" }
        ]}})
    }

    #[test]
    fn only_maintenance_notice_survives() {
        let notices = extract_service_notices(&feed(), &tz(), "RU", 5);
        assert_eq!(notices.len(), 1);
        let n = &notices[0];
        assert_eq!(n.id, "8786");
        assert_eq!(n.kind, NoticeKind::Maintenance);
        assert_eq!(n.headline, "Технические работы");
        assert!(
            n.body
                .starts_with("Сообщаем, что часть телеканалов будет временно недоступна"),
            "{}",
            n.body
        );
        assert!(
            n.body.ends_with("с момента завершения работ."),
            "{}",
            n.body
        );
        assert!(!n.body.contains("Maintenance") && !n.body.contains("Приносим извинения"));
        assert_eq!(n.published_at, "2026-09-14T10:06:44.000Z");
    }

    #[test]
    fn unpublished_ignored() {
        let mut f = feed();
        f["data"]["items"][0]["isPublished"] = json!(false);
        f["data"]["items"].as_array_mut().unwrap().truncate(1);
        assert_eq!(extract_service_notices(&f, &tz(), "RU", 5), []);
    }

    #[test]
    fn classification() {
        for t in [
            "Наблюдаются перебои с вещанием некоторых каналов",
            "Сбой на одном из серверов, специалисты уже работают",
            "Проблемы с воспроизведением архива на части каналов",
            "Вещание всех каналов восстановлено",
            "Some channels are temporarily unavailable",
        ] {
            assert!(is_service_notice(t), "{t}");
        }
        for t in [
            "Сборник лучших фильмов на новом канале",
            "Каналы завершили свое вещание и были удалены из списков",
            "Новый канал с 5 сентября! Обновляйте плейлисты!",
        ] {
            assert!(!is_service_notice(t), "{t}");
        }
    }

    #[test]
    fn language_sections() {
        let f = feed();
        let inline = html_to_paragraphs(f["data"]["items"][0]["html"].as_str().unwrap()).join("\n");
        assert!(language_section(&inline, "RU").starts_with("⚠️ Технические работы!"));
        assert!(!language_section(&inline, "RU").contains("Technical"));
        let split = html_to_paragraphs(f["data"]["items"][1]["html"].as_str().unwrap()).join("\n");
        let ru = language_section(&split, "RU");
        assert!(ru.contains("СМЕРШ-ТВ") && !ru.contains("SMERSH"));
        assert!(language_section(&split, "EN").contains("Россия"));
    }

    #[test]
    fn entities_and_summary() {
        assert_eq!(
            html_to_paragraphs(
                "<p><strong>&#34;A&#34;</strong> &amp; B&#39;s</p><p></p><p>x&nbsp;y</p>"
            ),
            ["\"A\" & B's", "x y"]
        );
        assert_eq!(
            summarize_notice(
                "Сейчас наблюдаются перебои с вещанием части каналов. Приносим извинения.",
                NoticeKind::Outage
            ),
            (
                "Перебои в работе".to_owned(),
                "Сейчас наблюдаются перебои с вещанием части каналов.".to_owned()
            )
        );
    }

    #[test]
    fn active_window() {
        let mk = |id: &str, at: &str| ProviderNotice {
            id: id.into(),
            published_at: at.into(),
            kind: NoticeKind::Outage,
            headline: String::new(),
            ..ProviderNotice::default()
        };
        let ns = [
            mk("new", "2026-09-14T10:00:00.000Z"),
            mk("old", "2026-09-12T10:00:00.000Z"),
        ];
        let now: Timestamp = "2026-09-14T20:00:00Z".parse().unwrap();
        let ids = |h| {
            active_notices(&ns, now, h)
                .into_iter()
                .map(|n| n.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(24.0), ["new"]);
        assert_eq!(ids(72.0), ["new", "old"]);
    }

    #[test]
    fn cookie_jar() {
        let now = "2026-09-14T12:00:00Z"
            .parse::<Timestamp>()
            .unwrap()
            .as_millisecond();
        let next = apply_set_cookies(
            "Cookie: access=old; refresh=r1; theme=dark",
            &[
                "access=new; Path=/; HttpOnly; Secure; SameSite=None".into(),
                "refresh=r2; Expires=Wed, 14 Oct 2026 12:00:00 GMT; Path=/v3/auth".into(),
                "theme=; Max-Age=0".into(),
                "csrf=abc==; Path=/".into(),
            ],
            now,
        );
        assert_eq!(next, "access=new; refresh=r2; csrf=abc==");
        assert_eq!(
            apply_set_cookies(
                "a=1",
                &["a=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT".into()],
                now
            ),
            ""
        );
        let jar = parse_cookie_header("a=1;\n b = 2 ;junk");
        assert_eq!(
            jar.into_iter().collect::<Vec<_>>(),
            [("a".into(), "1".into()), ("b".into(), "2".into())]
        );
    }
}
