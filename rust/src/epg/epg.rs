//! Per-user XMLTV programme guide advertised via `url-tvg` in the `.m3u`.
//! There is no real schedule — the channel is a looping info card — so the
//! guide is synthesised: one programme per calendar day.
//!
//! A player shows exactly ONE line of this: the programme TITLE. That line is
//! the customer's own subscription status ("✓ Подписка активна · ещё 89
//! дней"); the day's service state is folded in only when something is
//! wrong — an incident must never be hidden, but "all good" must never crowd
//! out the account status. Pure logic, no I/O.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

use crate::core::util::{
    AccountStatus, account_status, days_left, format_date, format_price, local_time_to_timestamp, period_label,
    plural_days, xml_escape,
};
use crate::data::model::{DecoratedUser, Incident, Severity};
use crate::render::status::{format_uptime, severity_for_day, status_summary, summary_today};

/// Stable XMLTV channel id, also the `.m3u` `tvg-id` so players link the two.
pub fn epg_channel_id(token: &str) -> String {
    format!("account-{token}")
}

/// Options shared by the XMLTV and FOSS renderers.
#[derive(Debug, Clone)]
pub struct EpgOptions<'a> {
    pub brand: &'a str,
    pub incidents: &'a [Incident],
    pub now: Timestamp,
    pub tz: &'a TimeZone,
    pub days_ahead: i64,
    pub days_behind: i64,
    pub expiring_threshold_days: i64,
}

/// "+0300" / "-0500" offset of `instant` in `tz` (DST-correct).
fn tz_offset(instant: Timestamp, tz: &TimeZone) -> String {
    let secs = tz.to_offset(instant).seconds();
    let min = secs.div_euclid(60);
    let sign = if min >= 0 { '+' } else { '-' };
    let abs = min.abs();
    format!("{sign}{:02}{:02}", abs / 60, abs % 60)
}

fn day_start(date: Date, tz: &TimeZone) -> Timestamp {
    local_time_to_timestamp(date, 0, 0, 0, tz)
}

/// XMLTV timestamp "YYYYMMDDHHMMSS +0300" for local midnight starting `date`.
fn day_start_xmltv(date: Date, tz: &TimeZone) -> String {
    format!("{}000000 {}", date.strftime("%Y%m%d"), tz_offset(day_start(date, tz), tz))
}

/// Unix seconds of local midnight starting `date`.
pub fn day_start_unix(date: Date, tz: &TimeZone) -> i64 {
    day_start(date, tz).as_second()
}

fn service_title(s: Severity) -> &'static str {
    match s {
        Severity::Operational => "✓ Все сервисы работают",
        Severity::Degraded => "⚠ Частичная деградация сервиса",
        Severity::Outage => "✕ Сбой в работе сервиса",
    }
}

fn service_short(s: Severity) -> &'static str {
    match s {
        Severity::Operational => "",
        Severity::Degraded => "⚠ Перебои в работе",
        Severity::Outage => "✕ Сбой сервиса",
    }
}

fn account_title(s: AccountStatus) -> (&'static str, &'static str) {
    match s {
        AccountStatus::Active => ("✓", "Подписка активна"),
        AccountStatus::Expiring => ("⚠", "Подписка истекает"),
        AccountStatus::Expired => ("✕", "Подписка истекла"),
        AccountStatus::Disabled => ("✕", "Аккаунт отключён"),
    }
}

/// "ещё 4 дня" / "последний день" / "бессрочно" / "истекла 3 дня назад".
fn remaining_text(left: Option<i64>) -> String {
    match left {
        None => "бессрочно".to_owned(),
        Some(0) => "последний день".to_owned(),
        Some(l) if l < 0 => format!("истекла {} {} назад", -l, plural_days(l)),
        Some(l) => format!("ещё {l} {}", plural_days(l)),
    }
}

#[derive(Debug, Clone)]
pub struct AccountLine {
    pub status: AccountStatus,
    pub left: Option<i64>,
    pub icon: &'static str,
    pub text: String,
}

fn account_short(user: &DecoratedUser, instant: Timestamp, opts: &EpgOptions<'_>) -> AccountLine {
    let expires = user.expires_at.as_deref();
    let status = account_status(user.active, expires, opts.expiring_threshold_days, instant, opts.tz);
    let left = days_left(expires, instant, opts.tz);
    let (icon, text) = account_title(status);
    // An expired or deactivated account says all it needs to in the label.
    let text = if matches!(status, AccountStatus::Expired | AccountStatus::Disabled) {
        text.to_owned()
    } else {
        format!("{text} · {}", remaining_text(left))
    };
    AccountLine { status, left, icon, text }
}

fn plan_line(user: &DecoratedUser) -> Option<String> {
    if user.plan_name.is_empty() {
        return None;
    }
    let price = if user.price_cents == 0 {
        String::new()
    } else {
        format!(" · {}{}", format_price(user.price_cents, &user.currency), period_label(&user.billing_period))
    };
    Some(format!("Тариф: {}{price}", user.plan_name))
}

fn expiry_line(user: &DecoratedUser, account: &AccountLine) -> String {
    if account.status == AccountStatus::Disabled {
        return "Аккаунт отключён администратором".to_owned();
    }
    match user.expires_at.as_deref().filter(|s| !s.is_empty()) {
        None => "Подписка бессрочная".to_owned(),
        Some(exp) => format!("Действует до {} · {}", format_date(Some(exp)), remaining_text(account.left)),
    }
}

/// One day of the guide: calendar bounds plus the already-rendered text, so
/// the XMLTV and FOSS guides can never tell one customer two different things.
#[derive(Debug, Clone)]
pub struct EpgDay {
    pub date: Date,
    pub next: Date,
    pub severity: Severity,
    pub account: AccountLine,
    pub title: String,
    pub expiry: String,
    pub desc: String,
}

fn incident_line(inc: &Incident, sev: Severity) -> String {
    let start = inc.starts_on.as_deref();
    let span = match inc.ends_on.as_deref().filter(|e| !e.is_empty()) {
        None => format!("с {}, сейчас", format_date(start)),
        Some(end) if Some(end) == start => format_date(start),
        Some(end) => format!("{}–{}", format_date(start), format_date(Some(end))),
    };
    let note = if inc.note.is_empty() { String::new() } else { format!(" — {}", inc.note) };
    format!("{} ({span}): {}{note}", sev.label(), inc.title)
}

pub fn each_epg_day(user: &DecoratedUser, opts: &EpgOptions<'_>) -> Vec<EpgDay> {
    let summary = status_summary(opts.incidents, opts.now, opts.tz, 90);
    let Some(today) = summary_today(&summary) else { return Vec::new() };
    let today_str = today.to_string();
    let uptime = format!("Доступность за 90 дней: {}", format_uptime(summary.uptime_pct));
    let plan = plan_line(user);

    (-opts.days_behind..=opts.days_ahead)
        .filter_map(|i| today.checked_add(i.days()).ok())
        .filter_map(|date| {
            let next = date.tomorrow().ok()?;
            let date_str = date.to_string();
            let severity = severity_for_day(opts.incidents, &date_str, &today_str);
            let noon = local_time_to_timestamp(date, 12, 0, 0, opts.tz);
            let account = account_short(user, noon, opts);
            let expiry = expiry_line(user, &account);

            let incident_lines = opts.incidents.iter().filter_map(|inc| {
                let sev = inc.severity()?;
                let start = inc.starts_on.as_deref().filter(|s| !s.is_empty())?;
                let end = inc.ends_on.as_deref().filter(|s| !s.is_empty()).unwrap_or(&today_str);
                (start <= date_str.as_str() && date_str.as_str() <= end).then(|| incident_line(inc, sev))
            });

            let title = if severity == Severity::Operational {
                format!("{} {}", account.icon, account.text)
            } else {
                format!("{} · {}", service_short(severity), account.text)
            };
            let desc = plan
                .iter()
                .cloned()
                .chain([expiry.clone(), format!("Статус сервиса: {}", service_title(severity)), uptime.clone()])
                .chain(incident_lines)
                .collect::<Vec<_>>()
                .join("\n");
            Some(EpgDay { date, next, severity, account, title, expiry, desc })
        })
        .collect()
}

/// The full XMLTV document for one user.
pub fn build_epg_xml(user: &DecoratedUser, opts: &EpgOptions<'_>) -> String {
    let channel_id = xml_escape(&epg_channel_id(&user.token));
    let channel_name = format!("{} — {}", opts.brand, user.username);
    let mut lines = vec![
        r#"<?xml version="1.0" encoding="UTF-8"?>"#.to_owned(),
        r#"<tv generator-info-name="iptv-info-channel">"#.to_owned(),
        format!(r#"  <channel id="{channel_id}">"#),
        format!("    <display-name>{}</display-name>", xml_escape(&channel_name)),
        format!("    <display-name>{}</display-name>", xml_escape(opts.brand)),
        "  </channel>".to_owned(),
    ];
    for day in each_epg_day(user, opts) {
        lines.push(format!(
            r#"  <programme start="{}" stop="{}" channel="{channel_id}">"#,
            day_start_xmltv(day.date, opts.tz),
            day_start_xmltv(day.next, opts.tz)
        ));
        lines.push(format!(r#"    <title lang="ru">{}</title>"#, xml_escape(&day.title)));
        lines.push(format!(r#"    <sub-title lang="ru">{}</sub-title>"#, xml_escape(&day.expiry)));
        lines.push(format!(r#"    <desc lang="ru">{}</desc>"#, xml_escape(&day.desc)));
        lines.push(r#"    <category lang="ru">Статус подписки</category>"#.to_owned());
        lines.push("  </programme>".to_owned());
    }
    lines.push("</tv>".to_owned());
    lines.push(String::new());
    lines.join("\n")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::data::model::{Plan, User};
    use serde_json::Map;

    pub fn tz() -> TimeZone {
        TimeZone::get("Europe/Tallinn").unwrap()
    }

    pub fn now() -> Timestamp {
        "2026-06-13T12:00:00Z".parse().unwrap()
    }

    pub fn user(token: &str, username: &str, expires: Option<&str>, active: bool, with_plan: bool) -> DecoratedUser {
        let u = User {
            id: 1,
            username: username.into(),
            token: token.into(),
            notify_token: String::new(),
            plan_id: if with_plan { "basic".into() } else { String::new() },
            expires_at: expires.map(Into::into),
            active,
            max_devices: None,
            created_at: String::new(),
            updated_at: String::new(),
            extra: Map::new(),
        };
        let plan = Plan {
            id: "basic".into(),
            name: "Базовый".into(),
            price_cents: 499,
            currency: "EUR".into(),
            billing_period: "month".into(),
            sort: 1.0,
            category_ids: vec![],
            max_devices: 0,
            extra: Map::new(),
        };
        DecoratedUser::decorate(u, with_plan.then_some(&plan))
    }

    pub fn ivan() -> DecoratedUser {
        user("abc123", "ivan", Some("2026-06-30"), true, true)
    }

    pub fn opts<'a>(tz: &'a TimeZone, incidents: &'a [Incident], ahead: i64, behind: i64) -> EpgOptions<'a> {
        EpgOptions {
            brand: "TestIPTV",
            incidents,
            now: now(),
            tz,
            days_ahead: ahead,
            days_behind: behind,
            expiring_threshold_days: 7,
        }
    }

    fn titles(xml: &str) -> Vec<String> {
        crate::regex!(r"<title[^>]*>([^<]*)</title>").captures_iter(xml).map(|c| c[1].to_owned()).collect()
    }

    #[test]
    fn well_formed_document() {
        let tz = tz();
        let xml = build_epg_xml(&ivan(), &opts(&tz, &[], 2, 1));
        assert!(xml.starts_with(r#"<?xml version="1.0" encoding="UTF-8"?>"#));
        assert!(xml.contains(r#"<channel id="account-abc123">"#));
        assert!(xml.contains("<display-name>TestIPTV — ivan</display-name>"));
        assert!(xml.ends_with("</tv>\n"));
        assert_eq!(xml.matches("<programme ").count(), 4);
        assert!(xml.contains(r#"start="20260612000000 +0300""#));
        assert!(xml.contains(r#"stop="20260616000000 +0300""#));
    }

    #[test]
    fn healthy_day_titles_with_subscription_status() {
        let tz = tz();
        let xml = build_epg_xml(&ivan(), &opts(&tz, &[], 2, 1));
        let t = titles(&xml);
        assert_eq!(t.len(), 4);
        let re = crate::regex!(r"^✓ Подписка активна · ещё (\d+) дн[а-я]+$");
        let left: Vec<i64> = t.iter().map(|s| re.captures(s).unwrap()[1].parse().unwrap()).collect();
        assert_eq!(left[0], left[1] + 1);
        assert!(xml.contains("Статус сервиса: ✓ Все сервисы работают"));
        assert!(crate::regex!(r#"<sub-title lang="ru">Действует до 30 июн 2026 · ещё \d+ дн[а-я]+</sub-title>"#).is_match(&xml));
        assert!(xml.contains("Тариф: Базовый · 4,99 €/мес."));
    }

    #[test]
    fn outage_folded_into_title() {
        let tz = tz();
        let incs = [Incident {
            id: "x".into(),
            severity: "outage".into(),
            title: "Сбой CDN".into(),
            starts_on: Some("2026-06-13".into()),
            note: "чиним".into(),
            ..Incident::default()
        }];
        let xml = build_epg_xml(&ivan(), &opts(&tz, &incs, 2, 1));
        assert!(crate::regex!(r#"<title lang="ru">✕ Сбой сервиса · Подписка активна · ещё \d+ дн[а-я]+</title>"#).is_match(&xml));
        assert!(xml.contains("Сбой (с 13 июн 2026, сейчас): Сбой CDN — чиним"));
        assert!(crate::regex!(r#"<title lang="ru">✓ Подписка активна · ещё \d+ дн[а-я]+</title>"#).is_match(&xml));
    }

    #[test]
    fn last_day_open_ended_disabled_expired() {
        let tz = tz();
        let o = opts(&tz, &[], 0, 0);
        let xml = build_epg_xml(&user("abc123", "ivan", Some("2026-06-13"), true, true), &o);
        assert!(xml.contains(r#"<title lang="ru">⚠ Подписка истекает · последний день</title>"#));
        let xml = build_epg_xml(&user("abc123", "ivan", None, true, true), &o);
        assert!(xml.contains(r#"<title lang="ru">✓ Подписка активна · бессрочно</title>"#));
        assert!(xml.contains(r#"<sub-title lang="ru">Подписка бессрочная</sub-title>"#));
        let xml = build_epg_xml(&user("abc123", "ivan", Some("2026-06-30"), false, true), &o);
        assert!(xml.contains(r#"<title lang="ru">✕ Аккаунт отключён</title>"#));
        assert!(!xml.contains("ещё "));
        let xml = build_epg_xml(&user("t", "u", Some("2026-06-10"), true, false), &o);
        assert!(xml.contains(r#"<title lang="ru">✕ Подписка истекла</title>"#));
        assert!(xml.contains(r#"<sub-title lang="ru">Действует до 10 июн 2026 · истекла 3 дня назад</sub-title>"#));
    }

    #[test]
    fn values_escaped() {
        let tz = tz();
        let incs = [Incident {
            severity: "degraded".into(),
            title: "A & B \"x\"".into(),
            starts_on: Some("2026-06-13".into()),
            ..Incident::default()
        }];
        let mut o = opts(&tz, &incs, 0, 0);
        o.brand = "<Brand>";
        let xml = build_epg_xml(&user("t", "a & b", None, true, false), &o);
        assert!(xml.contains("a &amp; b"));
        assert!(xml.contains("&lt;Brand&gt;"));
        assert!(xml.contains("A &amp; B &quot;x&quot;"));
    }
}
