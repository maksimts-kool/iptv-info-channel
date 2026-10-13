//! Derives the service-status summary (Better Stack–style 90-day uptime strip)
//! from the manually created incidents. Pure logic, no I/O.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};
use serde::Serialize;

use crate::core::util::{local_date, parse_instant, parse_ymd_prefix};
use crate::data::model::{Incident, Severity};
use crate::news::notices::{NoticeKind, ProviderNotice};

/// Overall state shown in the headline. `Provider` is ours-operational with
/// upstream trouble (blue instead of green).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusState {
    Operational,
    Degraded,
    Outage,
    Provider,
}

impl From<Severity> for StatusState {
    fn from(s: Severity) -> Self {
        match s {
            Severity::Operational => Self::Operational,
            Severity::Degraded => Self::Degraded,
            Severity::Outage => Self::Outage,
        }
    }
}

pub const PROVIDER_COLOR: &str = "#2563eb";
pub const PROVIDER_LABEL: &str = "Провайдер";

fn headline(severity: Severity) -> &'static str {
    match severity {
        Severity::Operational => "Все сервисы работают",
        Severity::Degraded => "Частичная деградация сервиса",
        Severity::Outage => "Сбой в работе сервиса",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayCell {
    pub date: String,
    pub severity: Severity,
    pub color: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub provider: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSummary {
    pub state: StatusState,
    pub label: &'static str,
    pub color: &'static str,
    pub uptime_pct: f64,
    pub days: Vec<DayCell>,
    pub active_incidents: Vec<Incident>,
    pub provider_notices: Vec<ProviderNotice>,
}

/// An incident's validated span, or `None` when it cannot be drawn.
fn span(inc: &Incident) -> Option<(Severity, &str, Option<&str>)> {
    let sev = inc.severity()?;
    let start = inc.starts_on.as_deref().filter(|s| !s.is_empty())?;
    Some((sev, start, inc.ends_on.as_deref().filter(|s| !s.is_empty())))
}

/// Does the incident cover `day`? Open-ended incidents run through today.
/// Dates are `YYYY-MM-DD`, so string comparison is calendar comparison.
fn covers(start: &str, end: Option<&str>, day: &str, today: &str) -> bool {
    start <= day && day <= end.unwrap_or(today)
}

/// Worst severity among incidents covering calendar day `day`.
pub fn severity_for_day(incidents: &[Incident], day: &str, today: &str) -> Severity {
    incidents
        .iter()
        .filter_map(span)
        .filter(|(_, start, end)| covers(start, *end, day, today))
        .map(|(sev, ..)| sev)
        .max()
        .unwrap_or(Severity::Operational)
}

/// The `days` calendar dates ending at (and including) `today`, oldest first.
fn calendar_window(today: Date, days: i64) -> Vec<String> {
    (0..days).rev().filter_map(|i| today.checked_sub(i.days()).ok()).map(|d| d.to_string()).collect()
}

pub fn status_summary(incidents: &[Incident], now: Timestamp, tz: &TimeZone, days: i64) -> StatusSummary {
    let today_date = local_date(now, tz);
    let today = today_date.to_string();
    let valid: Vec<Incident> = incidents.iter().filter(|i| span(i).is_some()).cloned().collect();

    let cells: Vec<DayCell> = calendar_window(today_date, days)
        .into_iter()
        .map(|date| {
            let severity = severity_for_day(&valid, &date, &today);
            DayCell { date, severity, color: severity.color(), provider: false }
        })
        .collect();
    let operational = cells.iter().filter(|c| c.severity == Severity::Operational).count();

    // Incidents covering "today" drive the headline.
    let active: Vec<Incident> = valid
        .iter()
        .filter(|i| span(i).is_some_and(|(_, start, end)| covers(start, end, &today, &today)))
        .cloned()
        .collect();
    let state = active.iter().filter_map(Incident::severity).max().unwrap_or(Severity::Operational);

    StatusSummary {
        state: state.into(),
        label: headline(state),
        color: state.color(),
        uptime_pct: (operational as f64 / days as f64 * 1000.0).round() / 10.0,
        days: cells,
        active_incidents: active,
        provider_notices: Vec::new(),
    }
}

/// Mix the provider's service notices into a summary: same event list, in
/// blue; when our own state is operational the overall state becomes
/// `Provider`. Our degraded/outage still wins; uptime is untouched.
pub fn with_provider_notices(mut summary: StatusSummary, notices: &[ProviderNotice], tz: &TimeZone) -> StatusSummary {
    if notices.is_empty() {
        summary.provider_notices.clear();
        return summary;
    }
    let notice_days: Vec<String> = notices
        .iter()
        .filter_map(|n| parse_instant(&n.published_at))
        .map(|t| local_date(t, tz).to_string())
        .collect();
    for day in &mut summary.days {
        if day.severity == Severity::Operational && notice_days.contains(&day.date) {
            day.color = PROVIDER_COLOR;
            day.provider = true;
        }
    }
    summary.provider_notices = notices.to_vec();
    if summary.state == StatusState::Operational {
        let maintenance = notices.iter().any(|n| n.kind == NoticeKind::Maintenance);
        summary.state = StatusState::Provider;
        summary.label = if maintenance { "Технические работы у провайдера" } else { "Перебои у провайдера" };
        summary.color = PROVIDER_COLOR;
    }
    summary
}

/// "100%", "99,9%" (EU comma decimal).
pub fn format_uptime(pct: f64) -> String {
    if pct.fract() == 0.0 { format!("{pct:.0}%") } else { format!("{pct:.1}%").replace('.', ",") }
}

/// The last cell's date — the summary window always ends "today".
pub fn summary_today(summary: &StatusSummary) -> Option<Date> {
    summary.days.last().and_then(|d| parse_ymd_prefix(&d.date))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tz() -> TimeZone {
        TimeZone::get("Europe/Tallinn").unwrap()
    }
    fn now() -> Timestamp {
        "2026-06-13T12:00:00Z".parse().unwrap()
    }
    fn inc(sev: &str, start: Option<&str>, end: Option<&str>) -> Incident {
        Incident {
            severity: sev.into(),
            starts_on: start.map(Into::into),
            ends_on: end.map(Into::into),
            ..Incident::default()
        }
    }
    fn by_date(s: &StatusSummary, d: &str) -> Severity {
        s.days.iter().find(|c| c.date == d).unwrap().severity
    }

    #[test]
    fn no_incidents_fully_operational() {
        let s = status_summary(&[], now(), &tz(), 90);
        assert_eq!(s.state, StatusState::Operational);
        assert_eq!(s.label, "Все сервисы работают");
        assert!((s.uptime_pct - 100.0).abs() < f64::EPSILON);
        assert_eq!(s.days.len(), 90);
        assert_eq!(s.days.last().unwrap().date, "2026-06-13");
        assert_eq!(s.days[0].date, "2026-03-16");
    }

    #[test]
    fn ended_incident_colours_its_days() {
        let s = status_summary(&[inc("outage", Some("2026-06-10"), Some("2026-06-11"))], now(), &tz(), 90);
        assert_eq!(s.state, StatusState::Operational);
        assert_eq!(by_date(&s, "2026-06-09"), Severity::Operational);
        assert_eq!(by_date(&s, "2026-06-10"), Severity::Outage);
        assert_eq!(by_date(&s, "2026-06-11"), Severity::Outage);
        assert_eq!(by_date(&s, "2026-06-12"), Severity::Operational);
        assert!((s.uptime_pct - (88.0_f64 / 90.0 * 1000.0).round() / 10.0).abs() < 1e-9);
    }

    #[test]
    fn open_ended_incident_active_today() {
        let s = status_summary(&[inc("degraded", Some("2026-06-12"), None)], now(), &tz(), 90);
        assert_eq!(s.state, StatusState::Degraded);
        assert_eq!(s.active_incidents.len(), 1);
        assert_eq!(by_date(&s, "2026-06-13"), Severity::Degraded);
    }

    #[test]
    fn worst_wins_and_invalid_ignored() {
        let s = status_summary(
            &[inc("degraded", Some("2026-06-13"), None), inc("outage", Some("2026-06-13"), Some("2026-06-13"))],
            now(),
            &tz(),
            90,
        );
        assert_eq!(s.state, StatusState::Outage);
        let s = status_summary(&[inc("unknown", Some("2026-06-13"), None), inc("outage", None, None)], now(), &tz(), 90);
        assert_eq!(s.state, StatusState::Operational);
        let s = status_summary(&[inc("outage", Some("2026-06-20"), Some("2026-06-21"))], now(), &tz(), 90);
        assert!((s.uptime_pct - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn uptime_format() {
        assert_eq!(format_uptime(100.0), "100%");
        assert_eq!(format_uptime(99.9), "99,9%");
    }

    fn notice(kind: NoticeKind) -> ProviderNotice {
        ProviderNotice {
            id: "1".into(),
            published_at: "2026-06-13T07:00:00Z".into(),
            kind,
            headline: "x".into(),
            body: String::new(),
            text: String::new(),
        }
    }

    #[test]
    fn provider_notices_turn_operational_blue() {
        let s = with_provider_notices(status_summary(&[], now(), &tz(), 90), &[notice(NoticeKind::Outage)], &tz());
        assert_eq!(s.state, StatusState::Provider);
        assert_eq!(s.label, "Перебои у провайдера");
        assert_eq!(s.days.last().unwrap().color, PROVIDER_COLOR);
        assert_eq!(s.days[s.days.len() - 2].color, Severity::Operational.color());
    }

    #[test]
    fn own_incident_outranks_provider() {
        let base = status_summary(&[inc("degraded", Some("2026-06-13"), None)], now(), &tz(), 90);
        let s = with_provider_notices(base.clone(), &[notice(NoticeKind::Maintenance)], &tz());
        assert_eq!(s.state, StatusState::Degraded);
        assert_eq!(s.days.last().unwrap().color, Severity::Degraded.color());
        assert_eq!(with_provider_notices(base.clone(), &[], &tz()), base);
    }
}
