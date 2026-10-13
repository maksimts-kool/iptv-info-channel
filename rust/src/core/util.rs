//! Shared helpers: price formatting, date math, account status.
//!
//! Timezone is load-bearing. Day-counting, expiry, the daily cron and every
//! displayed date go through these helpers (configured TZ, default
//! Europe/Tallinn) — never raw UTC math — so an account stays valid through
//! 23:59 on its expiry date in the configured zone.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};
use serde::{Deserialize, Serialize};

/// Format integer cents as EUR "4,99 €" (comma decimal, EU style).
pub fn format_price(cents: i64, currency: &str) -> String {
    let symbol = if currency == "EUR" { "€" } else { currency };
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{},{:02} {symbol}", abs / 100, abs % 100)
}

/// Human-readable period suffix for a plan: `/мес.`, `/год`, or empty.
pub fn period_label(period: &str) -> &'static str {
    match period {
        "month" => "/мес.",
        "year" => "/год",
        _ => "",
    }
}

/// Escape a string for safe interpolation into XML/SVG text or attributes.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Parse the leading `YYYY-MM-DD` of a string (anything may follow, as with
/// the JS regex `^(\d{4})-(\d{2})-(\d{2})`).
pub fn parse_ymd_prefix(s: &str) -> Option<Date> {
    let bytes = s.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<i32> {
        let part = s.get(r)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    Date::new(
        i16::try_from(year).ok()?,
        i8::try_from(month).ok()?,
        i8::try_from(day).ok()?,
    )
    .ok()
}

/// Parse an exact `YYYY-MM-DD` string.
pub fn parse_ymd(s: &str) -> Option<Date> {
    (s.len() == 10).then(|| parse_ymd_prefix(s)).flatten()
}

/// Convert a local wall-clock time in a timezone to a real instant (DST-aware;
/// a time in a spring-forward gap resolves forward, as the JS version did).
pub fn local_time_to_timestamp(date: Date, hour: i8, minute: i8, second: i8, tz: &TimeZone) -> Timestamp {
    tz.to_ambiguous_timestamp(date.at(hour, minute, second, 0))
        .compatible()
        .unwrap_or(Timestamp::UNIX_EPOCH)
}

/// The calendar date of `now` in `tz`.
pub fn local_date(now: Timestamp, tz: &TimeZone) -> Date {
    now.to_zoned(tz.clone()).date()
}

/// `YYYY-MM-DD` of `now` in `tz`.
pub fn local_date_string(now: Timestamp, tz: &TimeZone) -> String {
    local_date(now, tz).to_string()
}

/// Calendar days remaining in `tz`. The expiry date itself returns 0.
pub fn days_left(date_str: Option<&str>, now: Timestamp, tz: &TimeZone) -> Option<i64> {
    let expiry = parse_ymd_prefix(date_str?)?;
    let today = local_date(now, tz);
    today.until(expiry).ok().map(|span| i64::from(span.get_days()))
}

/// Billing period for [`add_period`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Day,
    Month,
    Year,
}

impl Period {
    /// `''` counts as months, because a plan with no billing period is still
    /// sold by the month.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "day" => Some(Self::Day),
            "month" | "" => Some(Self::Month),
            "year" => Some(Self::Year),
            _ => None,
        }
    }
}

/// Add a billing period to a `YYYY-MM-DD` date and return the new date.
///
/// Month arithmetic behaves the way a human expects: adding a month to the
/// 31st of a month with no 31st clamps to the last day (31 янв + 1 мес =
/// 28 фев) rather than rolling into the next month.
pub fn add_period(date_str: &str, period: Period, count: i64) -> Option<String> {
    let date = parse_ymd(date_str)?;
    let span = match period {
        Period::Day => count.days(),
        Period::Month => count.months(),
        Period::Year => (count * 12).months(),
    };
    date.checked_add(span).ok().map(|d| d.to_string())
}

/// Account status, worst last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountStatus {
    Active,
    Expiring,
    Expired,
    Disabled,
}

impl AccountStatus {
    /// On-screen label (`STATUS_META.label`).
    pub fn label(self) -> &'static str {
        match self {
            Self::Active => "АКТИВЕН",
            Self::Expiring => "СКОРО ИСТЕКАЕТ",
            Self::Expired => "ПРОСРОЧЕН",
            Self::Disabled => "ОТКЛЮЧЁН",
        }
    }

    /// Status colour (`STATUS_META.color`).
    pub fn color(self) -> &'static str {
        match self {
            Self::Active => "#16a34a",
            Self::Expiring => "#d97706",
            Self::Expired => "#dc2626",
            Self::Disabled => "#6b7280",
        }
    }
}

/// `active` / `expiring` / `expired` / `disabled` for an account.
pub fn account_status(
    active: bool,
    expires_at: Option<&str>,
    expiring_threshold_days: i64,
    now: Timestamp,
    tz: &TimeZone,
) -> AccountStatus {
    if !active {
        return AccountStatus::Disabled;
    }
    match days_left(expires_at, now, tz) {
        Some(d) if d < 0 => AccountStatus::Expired,
        Some(d) if d <= expiring_threshold_days => AccountStatus::Expiring,
        _ => AccountStatus::Active,
    }
}

/// Russian pluralization for "день": 1 день, 2 дня, 5 дней.
pub fn plural_days(n: i64) -> &'static str {
    let a = n.abs() % 100;
    let b = a % 10;
    if a > 10 && a < 20 {
        "дней"
    } else if b == 1 {
        "день"
    } else if (2..=4).contains(&b) {
        "дня"
    } else {
        "дней"
    }
}

const MONTHS_SHORT: [&str; 12] = [
    "янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек",
];

/// Human-friendly date "09 июн 2026"; `—` for anything unparseable.
pub fn format_date(date_str: Option<&str>) -> String {
    date_str.and_then(parse_ymd_prefix).map_or_else(
        || "—".to_owned(),
        |d| format!("{:02} {} {}", d.day(), MONTHS_SHORT[(d.month() - 1) as usize], d.year()),
    )
}

/// Local wall-clock "HH:MM" for an instant, in `tz`.
pub fn format_time(at: Timestamp, tz: &TimeZone) -> String {
    let z = at.to_zoned(tz.clone());
    format!("{:02}:{:02}", z.hour(), z.minute())
}

/// Parse an ISO timestamp as stored by the Node version (`toISOString()`), or
/// a `YYYY-MM-DD HH:MM:SS` UTC stamp.
pub fn parse_instant(s: &str) -> Option<Timestamp> {
    s.parse::<Timestamp>().ok().or_else(|| {
        let dt: jiff::civil::DateTime = s.replace(' ', "T").parse().ok()?;
        dt.to_zoned(TimeZone::UTC).ok().map(|z| z.timestamp())
    })
}

/// `new Date().toISOString()` — millisecond precision, `Z` suffix.
pub fn iso_now() -> String {
    iso(Timestamp::now())
}

/// Millisecond-precision ISO 8601 UTC, exactly as JS `toISOString()`.
pub fn iso(at: Timestamp) -> String {
    at.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `YYYY-MM-DD HH:MM:SS` in UTC — the store's `created_at` stamp shape.
pub fn now_stamp() -> String {
    Timestamp::now().strftime("%Y-%m-%d %H:%M:%S").to_string()
}

/// Milliseconds since the epoch.
pub fn now_ms() -> i64 {
    Timestamp::now().as_millisecond()
}

/// Case-insensitive ordering with a stable tie-break — the stand-in for JS
/// `String.prototype.localeCompare` used to sort names for display.
pub fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

/// URL-safe random token without ambiguous characters (no 0/1/i/l/o).
pub fn make_token(len: usize) -> String {
    const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
    (0..len)
        .map(|_| ALPHABET[rand::random_range(0..ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tallinn() -> TimeZone {
        TimeZone::get("Europe/Tallinn").unwrap()
    }

    fn ts(s: &str) -> Timestamp {
        s.parse().unwrap()
    }

    #[test]
    fn add_period_does_subscription_month_arithmetic() {
        let m = |d, n| add_period(d, Period::Month, n);
        assert_eq!(m("2026-08-10", 1).as_deref(), Some("2026-09-10"));
        assert_eq!(m("2026-08-10", 3).as_deref(), Some("2026-11-10"));
        assert_eq!(add_period("2026-08-10", Period::Year, 1).as_deref(), Some("2027-08-10"));
        assert_eq!(add_period("2026-08-10", Period::Day, 14).as_deref(), Some("2026-08-24"));
        assert_eq!(Period::parse(""), Some(Period::Month));
        assert_eq!(m("2026-12-15", 2).as_deref(), Some("2027-02-15"));
    }

    #[test]
    fn add_period_clamps_to_last_day() {
        assert_eq!(
            add_period("2026-01-31", Period::Month, 1).as_deref(),
            Some("2026-02-28")
        );
        assert_eq!(
            add_period("2028-01-31", Period::Month, 1).as_deref(),
            Some("2028-02-29")
        );
        assert_eq!(
            add_period("2026-08-31", Period::Month, 1).as_deref(),
            Some("2026-09-30")
        );
        assert_eq!(add_period("2028-02-29", Period::Year, 1).as_deref(), Some("2029-02-28"));
    }

    #[test]
    fn add_period_rejects_garbage() {
        assert_eq!(add_period("", Period::Month, 1), None);
        assert_eq!(add_period("10.08.2026", Period::Month, 1), None);
    }

    #[test]
    fn local_date_string_uses_configured_zone() {
        assert_eq!(local_date_string(ts("2026-06-09T21:30:00Z"), &tallinn()), "2026-06-10");
    }

    #[test]
    fn local_wall_clock_to_instant_follows_dst() {
        let last_second = |d: &str| iso(local_time_to_timestamp(parse_ymd(d).unwrap(), 23, 59, 59, &tallinn()));
        assert_eq!(last_second("2026-06-09"), "2026-06-09T20:59:59.000Z");
        assert_eq!(last_second("2026-01-09"), "2026-01-09T21:59:59.000Z");
    }

    #[test]
    fn account_valid_through_last_second() {
        let now = ts("2026-06-09T20:59:59Z");
        assert_eq!(
            account_status(true, Some("2026-06-09"), 7, now, &tallinn()),
            AccountStatus::Expiring
        );
        assert_eq!(days_left(Some("2026-06-09"), now, &tallinn()), Some(0));
    }

    #[test]
    fn account_expires_at_local_midnight() {
        let now = ts("2026-06-09T21:00:00Z");
        assert_eq!(
            account_status(true, Some("2026-06-09"), 7, now, &tallinn()),
            AccountStatus::Expired
        );
        assert_eq!(days_left(Some("2026-06-09"), now, &tallinn()), Some(-1));
    }

    #[test]
    fn formatting_helpers() {
        assert_eq!(format_price(499, "EUR"), "4,99 €");
        assert_eq!(format_price(1000, "USD"), "10,00 USD");
        assert_eq!(format_date(Some("2026-06-09")), "09 июн 2026");
        assert_eq!(format_date(None), "—");
        assert_eq!(plural_days(1), "день");
        assert_eq!(plural_days(3), "дня");
        assert_eq!(plural_days(11), "дней");
        assert_eq!(plural_days(-21), "день");
        assert_eq!(xml_escape("<a & 'b'>"), "&lt;a &amp; &apos;b&apos;&gt;");
    }
}
