//! Email notifications. The intro slide shows a per-user QR to `/sub/:token`,
//! where a customer subscribes one address with opt-in topics. Mail goes on:
//! server-status changes (opt-in), an expiring subscription (opt-in, once per
//! expiry date), renewals (mandatory), channel-package changes (opt-in) and
//! the admin's newsletter (opt-in).
//!
//! Mail is sent over a third-party HTTP API (Brevo default, Resend optional)
//! because DigitalOcean blocks outbound SMTP. `NOTIFY_DRY_RUN` logs instead.
//! Subscriptions are double opt-in: nothing but the verification link goes to
//! an unverified address.

use std::sync::Arc;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::{Value, json};

use crate::config::{Config, MailProvider};
use crate::core::audience::{Audience, audience_matches, clean_audience};
use crate::core::util::{AccountStatus, account_status, days_left, format_date, plural_days, xml_escape};
use crate::data::model::{DecoratedUser, Incident, NotifyLogEntry, NotifyOptions, Subscriber};
use crate::data::store::Store;
use crate::regex;

fn valid_email(email: &str) -> bool {
    email.len() <= 254 && regex!(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").is_match(email)
}

/// A validated subscribe request. Renewal is always forced on.
pub fn validate_subscription(body: &Value) -> Result<(String, NotifyOptions), &'static str> {
    let email = body.get("email").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
    if email.is_empty() || !valid_email(&email) {
        return Err("Введите корректный адрес электронной почты");
    }
    let opt = body.get("options");
    let flag = |k: &str| opt.and_then(|o| o.get(k)).is_some_and(truthy);
    Ok((
        email,
        NotifyOptions { server: flag("server"), expiry: flag("expiry"), content: flag("content"), news: flag("news"), renewal: true },
    ))
}

/// JS truthiness for JSON values.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A rendered email.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub subject: String,
    pub html: String,
    pub text: String,
}

/// The HTTP request one provider wants for a message.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRequest {
    pub url: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

pub fn build_provider_request(cfg: &crate::config::Notify, to: &str, m: &Message) -> ProviderRequest {
    match cfg.provider {
        MailProvider::Brevo => ProviderRequest {
            url: "https://api.brevo.com/v3/smtp/email",
            headers: vec![("api-key", cfg.api_key.clone()), ("content-type", "application/json".into())],
            body: json!({
                "sender": { "email": cfg.from, "name": cfg.from_name },
                "to": [{ "email": to }],
                "subject": m.subject,
                "htmlContent": m.html,
                "textContent": m.text,
            }),
        },
        MailProvider::Resend => ProviderRequest {
            url: "https://api.resend.com/emails",
            headers: vec![("authorization", format!("Bearer {}", cfg.api_key)), ("content-type", "application/json".into())],
            body: json!({
                "from": if cfg.from_name.is_empty() { cfg.from.clone() } else { format!("{} <{}>", cfg.from_name, cfg.from) },
                "to": [to],
                "subject": m.subject,
                "html": m.html,
                "text": m.text,
            }),
        },
    }
}

// ---- Templates (Russian; every interpolated value is escaped) ----
// Light theme mirroring the admin UI; table layout + inline styles for email
// clients (no external CSS, no flexbox).

const FONT: &str = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const PAGE: &str = "#f5f5f5";
const CARD: &str = "#ffffff";
const BORDER: &str = "#f0f0f0";
const HEADING: &str = "#262626";
const TEXT: &str = "#595959";
const MUTED: &str = "#8c8c8c";
const PRIMARY: &str = "#2563eb";
const SUCCESS: &str = "#16a34a";
const ERROR: &str = "#dc2626";
const WARNING: &str = "#d97706";

fn layout(brand: &str, heading: &str, body: &str, accent: &str) -> String {
    let b = xml_escape(brand);
    format!(
        r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:{PAGE};font-family:{FONT}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PAGE};padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:{CARD};border:1px solid {BORDER};border-radius:12px;overflow:hidden">
        <tr><td style="height:4px;background:{accent};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:32px 32px 8px">
          <div style="font-size:12px;letter-spacing:2px;color:{PRIMARY};text-transform:uppercase;font-weight:600">{b}</div>
          <h1 style="font-size:24px;line-height:1.3;margin:12px 0 20px;color:{HEADING};font-weight:600">{h}</h1>
        </td></tr>
        <tr><td style="padding:0 32px 8px">{body}</td></tr>
        <tr><td style="padding:20px 32px 28px">
          <div style="border-top:1px solid {BORDER};padding-top:16px;font-size:12px;line-height:1.6;color:{MUTED}">
            {b} · автоматическое уведомление, отвечать на него не нужно.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"#,
        h = xml_escape(heading)
    )
}

fn p(t: &str) -> String {
    format!(r#"<p style="color:{TEXT};font-size:15px;line-height:1.6;margin:0 0 14px">{t}</p>"#)
}

fn button(label: &str, url: &str) -> String {
    format!(
        r#"<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px"><tr><td bgcolor="{PRIMARY}" style="border-radius:8px">
  <a href="{}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px">{}</a>
</td></tr></table>"#,
        xml_escape(url),
        xml_escape(label)
    )
}

fn callout(html: &str, color: &str) -> String {
    format!(
        r#"<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#fafafa;border:1px solid {BORDER};border-left:3px solid {color};border-radius:8px"><tr><td style="padding:14px 16px;color:{HEADING};font-size:15px;line-height:1.6">{html}</td></tr></table>"#
    )
}

fn list(items: &[String]) -> String {
    let rows: String = items
        .iter()
        .map(|o| {
            format!(
                r#"<tr><td style="padding:4px 0;color:{TEXT};font-size:15px;line-height:1.5"><span style="color:{PRIMARY};font-weight:700">&nbsp;•&nbsp;</span>{}</td></tr>"#,
                xml_escape(o)
            )
        })
        .collect();
    format!(r#"<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">{rows}</table>"#)
}

pub mod templates {
    use super::*;

    /// Double opt-in: the link the recipient must click.
    pub fn verification(brand: &str, url: &str) -> Message {
        let body = p("Вы запросили уведомления. Подтвердите этот адрес, чтобы активировать подписку:")
            + &button("Подтвердить адрес", url)
            + &p(&format!(
                r#"Если кнопка не работает, откройте ссылку:<br><a href="{u}" style="color:{PRIMARY};word-break:break-all">{u}</a>"#,
                u = xml_escape(url)
            ))
            + &p("Если это были не вы — просто проигнорируйте письмо, подписка не активируется.");
        Message {
            subject: format!("{brand}: подтвердите адрес для уведомлений"),
            html: layout(brand, "Подтвердите адрес", &body, PRIMARY),
            text: format!("Подтвердите адрес для уведомлений ({brand}): {url}"),
        }
    }

    pub fn confirmation(brand: &str, options: &NotifyOptions) -> Message {
        let opts: Vec<String> = [
            Some("Продление подписки"),
            options.expiry.then_some("Скоро истекает"),
            options.content.then_some("Изменения в списке каналов"),
            options.news.then_some("Новости и важные объявления"),
            options.server.then_some("Статус сервера"),
        ]
        .into_iter()
        .flatten()
        .map(str::to_owned)
        .collect();
        let body = p("Мы будем присылать письма по выбранным темам:")
            + &list(&opts)
            + &p("Изменить темы или отписаться можно на той же странице, где вы оформили подписку.");
        Message {
            subject: format!("{brand}: подписка на уведомления оформлена"),
            html: layout(brand, "Вы подписаны на уведомления", &body, SUCCESS),
            text: format!("Вы подписаны на уведомления ({brand}). Темы: {}.", opts.join(", ")),
        }
    }

    pub fn expiry(brand: &str, username: &str, expires_at: Option<&str>, now: Timestamp, tz: &TimeZone) -> Message {
        let left = match days_left(expires_at, now, tz) {
            Some(0) => "сегодня".to_owned(),
            Some(d) => format!("через {d} {}", plural_days(d)),
            None => String::new(),
        };
        let date = format_date(expires_at);
        let body = p(&format!("Здравствуйте, {}!", xml_escape(username)))
            + &callout(
                &format!(
                    r#"Подписка истекает <b style="color:{WARNING}">{}</b><br><span style="color:{TEXT};font-size:14px">Дата окончания: {}</span>"#,
                    xml_escape(&left),
                    xml_escape(&date)
                ),
                WARNING,
            )
            + &p("Продлите её, чтобы не потерять доступ.");
        Message {
            subject: format!("{brand}: подписка скоро истекает"),
            html: layout(brand, "Подписка скоро истекает", &body, WARNING),
            text: format!("Подписка истекает {left} ({date}). Продлите, чтобы сохранить доступ."),
        }
    }

    pub fn renewal(brand: &str, username: &str, expires_at: Option<&str>) -> Message {
        let date = format_date(expires_at);
        let body = p(&format!("Здравствуйте, {}!", xml_escape(username)))
            + &callout(
                &format!(r#"Новая дата окончания подписки:<br><b style="color:{SUCCESS}">{}</b>"#, xml_escape(&date)),
                SUCCESS,
            )
            + &p("Спасибо, что остаётесь с нами!");
        Message {
            subject: format!("{brand}: подписка продлена"),
            html: layout(brand, "Подписка продлена", &body, SUCCESS),
            text: format!("Ваша подписка продлена до {date}."),
        }
    }

    pub fn content_change(brand: &str, username: &str, change: &ContentChange, plan_name: &str) -> Message {
        let section = |label: &str, names: &[String]| {
            if names.is_empty() {
                String::new()
            } else {
                format!(
                    r#"<div style="color:{HEADING};font-size:14px;font-weight:600;margin:0 0 6px">{}</div>{}"#,
                    xml_escape(label),
                    list(names)
                )
            }
        };
        let added = change.added_categories.len() + change.added_channels.len();
        let removed = change.removed_categories.len() + change.removed_channels.len();
        let heading = if added > 0 && removed > 0 {
            "Список каналов изменился"
        } else if added > 0 {
            "В подписку добавлены каналы"
        } else {
            "Из подписки убраны каналы"
        };
        let intro = if plan_name.is_empty() {
            p("Состав вашего пакета каналов обновился:")
        } else {
            p(&format!("Изменения в вашем тарифе «{}»:", xml_escape(plan_name)))
        };
        let body = p(&format!("Здравствуйте, {}!", xml_escape(username)))
            + &intro
            + &section("Добавлены категории", &change.added_categories)
            + &section("Добавлены каналы", &change.added_channels)
            + &section("Больше не входят категории", &change.removed_categories)
            + &section("Больше не входят каналы", &change.removed_channels)
            + &p("Изменения уже действуют — обновите плейлист в плеере, если список не поменялся сам.");
        let line = |label: &str, names: &[String]| (!names.is_empty()).then(|| format!("{label}: {}", names.join(", ")));
        let text: Vec<String> = std::iter::once(Some(heading.to_owned()))
            .chain([
                line("Добавлены категории", &change.added_categories),
                line("Добавлены каналы", &change.added_channels),
                line("Убраны категории", &change.removed_categories),
                line("Убраны каналы", &change.removed_channels),
            ])
            .flatten()
            .collect();
        Message {
            subject: format!("{brand}: изменения в списке каналов"),
            html: layout(brand, heading, &body, if removed > 0 && added == 0 { WARNING } else { PRIMARY }),
            text: text.join("\n"),
        }
    }

    pub fn server_status(brand: &str, resolved: bool, incident: &Incident) -> Message {
        let heading = if resolved { "Сервис восстановлен" } else { "Проблема в работе сервиса" };
        let accent = if resolved { SUCCESS } else { ERROR };
        let note_html = if incident.note.is_empty() {
            String::new()
        } else {
            format!(r#"<br><span style="color:{TEXT};font-size:14px">{}</span>"#, xml_escape(&incident.note))
        };
        let note_text = if incident.note.is_empty() { String::new() } else { format!(" — {}", incident.note) };
        Message {
            subject: format!("{brand}: {}", if resolved { "сервис восстановлен" } else { "инцидент в работе сервиса" }),
            html: layout(brand, heading, &callout(&format!("<b>{}</b>{note_html}", xml_escape(&incident.title)), accent), accent),
            text: format!("{heading}: {}{note_text}", incident.title),
        }
    }

    /// The admin's announcement. Blank line = new paragraph; `important`
    /// only changes the look.
    pub fn newsletter(brand: &str, subject: &str, body: &str, important: bool) -> Message {
        let paragraphs: Vec<&str> = regex!(r"\n\s*\n").split(body).map(str::trim).filter(|s| !s.is_empty()).collect();
        let html: String = paragraphs.iter().map(|para| p(&xml_escape(para).replace('\n', "<br>"))).collect();
        let accent = if important { WARNING } else { PRIMARY };
        let lead = if important { callout(&format!(r#"<b style="color:{WARNING}">Важная информация</b>"#), WARNING) } else { String::new() };
        Message {
            subject: format!("{brand}: {}{subject}", if important { "Важно — " } else { "" }),
            html: layout(brand, subject, &(lead + &html), accent),
            text: format!("{}{subject}\n\n{}", if important { "ВАЖНО. " } else { "" }, paragraphs.join("\n\n")),
        }
    }

    pub fn test(brand: &str) -> Message {
        let body = p("Если вы видите это письмо, отправка уведомлений настроена правильно.")
            + &callout(&format!(r#"<b style="color:{SUCCESS}">✓ Отправка уведомлений работает</b>"#), SUCCESS);
        Message {
            subject: format!("{brand}: тестовое письмо"),
            html: layout(brand, "Тестовое письмо", &body, PRIMARY),
            text: "Тестовое письмо: отправка уведомлений настроена правильно.".to_owned(),
        }
    }
}

// ---- Channel-package changes ----

const MAX_LISTED: usize = 12;

/// Granting a category can add hundreds of channels, so a name list is
/// capped and the remainder summarised.
pub fn cap_names(names: &[String]) -> Vec<String> {
    let clean: Vec<String> = names.iter().filter(|n| !n.is_empty()).cloned().collect();
    if clean.len() <= MAX_LISTED {
        return clean;
    }
    let rest = clean.len() - MAX_LISTED;
    let mut out = clean[..MAX_LISTED].to_vec();
    out.push(format!("…и ещё {rest} {}", if rest == 1 { "позиция" } else { "позиций" }));
    out
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContentChange {
    pub added_categories: Vec<String>,
    pub removed_categories: Vec<String>,
    pub added_channels: Vec<String>,
    pub removed_channels: Vec<String>,
}

/// Capped lists, or `None` when nothing actually changed.
pub fn content_change_summary(diff: &ContentChange) -> Option<ContentChange> {
    let change = ContentChange {
        added_categories: cap_names(&diff.added_categories),
        removed_categories: cap_names(&diff.removed_categories),
        added_channels: cap_names(&diff.added_channels),
        removed_channels: cap_names(&diff.removed_channels),
    };
    let total = change.added_categories.len() + change.removed_categories.len() + change.added_channels.len() + change.removed_channels.len();
    (total > 0).then_some(change)
}

// ---- Newsletter ----

pub const NEWSLETTER_SUBJECT_MAX: usize = 150;
pub const NEWSLETTER_BODY_MAX: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewsletterDraft {
    pub subject: String,
    pub body: String,
    pub important: bool,
    pub audience: Option<Audience>,
}

pub fn validate_newsletter(body: &Value) -> Result<NewsletterDraft, String> {
    let subject = body.get("subject").and_then(Value::as_str).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    if subject.is_empty() {
        return Err("Укажите тему письма".into());
    }
    if subject.chars().count() > NEWSLETTER_SUBJECT_MAX {
        return Err(format!("Тема — не больше {NEWSLETTER_SUBJECT_MAX} символов"));
    }
    let text = body.get("body").and_then(Value::as_str).unwrap_or("").replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    if text.is_empty() {
        return Err("Напишите текст письма".into());
    }
    if text.chars().count() > NEWSLETTER_BODY_MAX {
        return Err(format!("Текст — не больше {NEWSLETTER_BODY_MAX} символов"));
    }
    let raw = body.get("audience").unwrap_or(&Value::Null);
    let audience = if raw.is_null() { None } else { clean_audience(raw) };
    if truthy(raw) && audience.is_none() {
        return Err("bad audience".into());
    }
    Ok(NewsletterDraft {
        subject,
        body: text.to_owned(),
        important: body.get("important") == Some(&Value::Bool(true)),
        audience,
    })
}

/// Who receives a newsletter: verified subscribers who opted into news,
/// whose customer still exists and is in the audience.
pub fn newsletter_recipients<'a>(
    audience: Option<&Audience>,
    users: &'a [DecoratedUser],
    subscribers: &'a [Subscriber],
) -> Vec<(&'a DecoratedUser, &'a Subscriber)> {
    subscribers
        .iter()
        .filter(|s| s.verified && s.options.news)
        .filter_map(|s| users.iter().find(|u| u.id == s.user_id).map(|u| (u, s)))
        .filter(|(u, _)| audience_matches(audience, Some(*u)))
        .collect()
}

/// Is this subscriber due an "expiring" email right now? Only a verified
/// address inside the threshold window, not already warned for this exact
/// expiry date (a renewal changes `expires_at`, which re-arms it).
pub fn expiry_due(user: &DecoratedUser, sub: &Subscriber, now: Timestamp, tz: &TimeZone, threshold: i64) -> bool {
    let Some(expires) = user.expires_at.as_deref() else { return false };
    sub.verified
        && sub.options.expiry
        && account_status(user.active, Some(expires), threshold, now, tz) == AccountStatus::Expiring
        && sub.last_expiry_notice.as_deref() != Some(expires)
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("email provider not configured (set NOTIFY_API_KEY and NOTIFY_FROM)")]
    NotConfigured,
    #[error("email send failed ({0}): {1}")]
    Rejected(u16, String),
    #[error("email send failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("bad email address")]
    BadAddress,
    #[error("уведомления выключены — включите их выше")]
    Disabled,
}

/// The mailer: transport, dispatch and the triggers that use it.
#[derive(Debug)]
pub struct Notifier {
    config: Arc<Config>,
    store: Arc<Store>,
    http: reqwest::Client,
}

/// Newsletter progress / result counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct SendCounts {
    pub recipients: usize,
    pub sent: usize,
    pub failed: usize,
}

impl Notifier {
    pub fn new(config: Arc<Config>, store: Arc<Store>, http: reqwest::Client) -> Self {
        Self { config, store, http }
    }

    pub fn enabled(&self) -> bool {
        self.config.notify_enabled()
    }

    /// The on-screen QR target. Uses the separate notify token, so the QR can
    /// be photographed without leaking stream access.
    pub fn subscribe_url_for(&self, user: &DecoratedUser) -> String {
        format!("{}/sub/{}", self.config.public_base_url, user.notify_token)
    }

    fn brand(&self) -> String {
        crate::data::store::setting_str(&self.store.settings(), "brand_name")
            .filter(|b| !b.is_empty())
            .unwrap_or("IPTV-сервис")
            .to_owned()
    }

    pub async fn send_email(&self, to: &str, m: &Message) -> Result<(), SendError> {
        let cfg = &self.config.notify;
        if cfg.dry_run {
            tracing::info!(target: "notify", %to, subject = %m.subject, "dry-run: email not sent");
            return Ok(());
        }
        if cfg.api_key.is_empty() || cfg.from.is_empty() {
            return Err(SendError::NotConfigured);
        }
        let req = build_provider_request(cfg, to, m);
        let mut builder = self.http.post(req.url).json(&req.body);
        for (k, v) in &req.headers {
            builder = builder.header(*k, v);
        }
        let res = builder.send().await?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let detail: String = res.text().await.unwrap_or_default().chars().take(200).collect();
            return Err(SendError::Rejected(status, detail));
        }
        Ok(())
    }

    async fn log(&self, user_id: Option<i64>, email: &str, kind: &str, error: Option<String>) {
        let entry = NotifyLogEntry { at: String::new(), user_id, email: email.to_owned(), kind: kind.to_owned(), ok: error.is_none(), error };
        if let Err(e) = self.store.notify_log_add(entry).await {
            tracing::error!(target: "notify", error = %e, "notify log write failed");
        }
    }

    /// Send, log, and never fail the caller.
    async fn dispatch(&self, kind: &str, user_id: i64, to: &str, m: &Message) -> bool {
        match self.send_email(to, m).await {
            Ok(()) => {
                self.log(Some(user_id), to, kind, None).await;
                true
            }
            Err(e) => {
                tracing::error!(target: "notify", %kind, %to, error = %e, "email send failed");
                self.log(Some(user_id), to, kind, Some(e.to_string())).await;
                false
            }
        }
    }

    pub async fn send_verification(&self, user: &DecoratedUser, sub: &Subscriber) -> bool {
        let url = format!("{}/sub/verify/{}", self.config.public_base_url, sub.verify_token.as_deref().unwrap_or(""));
        self.dispatch("verification", user.id, &sub.email, &templates::verification(&self.brand(), &url)).await
    }

    pub async fn send_confirmation(&self, user: &DecoratedUser, sub: &Subscriber) -> bool {
        self.dispatch("confirmation", user.id, &sub.email, &templates::confirmation(&self.brand(), &sub.options)).await
    }

    /// Mandatory renewal notice — whenever the expiry is pushed later.
    pub async fn notify_renewal(&self, user: &DecoratedUser) {
        if !self.enabled() {
            return;
        }
        let Some(sub) = self.store.subscriber(user.id).filter(|s| s.verified) else { return };
        let m = templates::renewal(&self.brand(), &user.username, user.expires_at.as_deref());
        self.dispatch("renewal", user.id, &sub.email, &m).await;
    }

    /// Opt-in (`content`): one customer's channel package changed.
    pub async fn notify_content_change(&self, user: &DecoratedUser, diff: &ContentChange, plan_name: &str) -> bool {
        if !self.enabled() {
            return false;
        }
        let Some(change) = content_change_summary(diff) else { return false };
        let Some(sub) = self.store.subscriber(user.id).filter(|s| s.verified && s.options.content) else { return false };
        let m = templates::content_change(&self.brand(), &user.username, &change, plan_name);
        self.dispatch("content", user.id, &sub.email, &m).await
    }

    /// Mail a newsletter to its recipients. With the switch off it errors
    /// rather than "sending" to nobody.
    pub async fn send_newsletter(&self, draft: &NewsletterDraft, mut progress: impl FnMut(SendCounts)) -> Result<SendCounts, SendError> {
        if !self.enabled() {
            return Err(SendError::Disabled);
        }
        let (users, subs) = (self.store.users(), self.store.subscribers());
        let recipients = newsletter_recipients(draft.audience.as_ref(), &users, &subs);
        let m = templates::newsletter(&self.brand(), &draft.subject, &draft.body, draft.important);
        let mut counts = SendCounts { recipients: recipients.len(), ..SendCounts::default() };
        for (user, sub) in recipients {
            if self.dispatch("news", user.id, &sub.email, &m).await {
                counts.sent += 1;
            } else {
                counts.failed += 1;
            }
            progress(counts);
        }
        Ok(counts)
    }

    /// The admin's preview copy; provider errors surface to the caller.
    pub async fn send_newsletter_test(&self, to: &str, draft: &NewsletterDraft) -> Result<(), SendError> {
        let email = to.trim().to_lowercase();
        if !valid_email(&email) {
            return Err(SendError::BadAddress);
        }
        let mut m = templates::newsletter(&self.brand(), &draft.subject, &draft.body, draft.important);
        m.subject = format!("[Тест] {}", m.subject);
        let result = self.send_email(&email, &m).await;
        self.log(None, &email, "news_test", result.as_ref().err().map(ToString::to_string)).await;
        result
    }

    /// Server-status change to everyone opted into it.
    pub async fn notify_server_status(&self, incident: &Incident, resolved: bool) {
        if !self.enabled() {
            return;
        }
        let m = templates::server_status(&self.brand(), resolved, incident);
        for sub in self.store.subscribers().into_iter().filter(|s| s.verified && s.options.server) {
            if self.store.user(sub.user_id).is_some() {
                self.dispatch("server", sub.user_id, &sub.email, &m).await;
            }
        }
    }

    /// The once-per-expiry warning sweep (daily cron, after the rebuild).
    pub async fn expiry_sweep(&self) -> usize {
        if !self.enabled() {
            return 0;
        }
        let (now, tz, threshold) = (Timestamp::now(), &self.config.tz, self.config.expiring_threshold_days);
        let brand = self.brand();
        let mut sent = 0;
        for sub in self.store.subscribers() {
            let Some(user) = self.store.user(sub.user_id) else { continue };
            if !expiry_due(&user, &sub, now, tz, threshold) {
                continue;
            }
            let m = templates::expiry(&brand, &user.username, user.expires_at.as_deref(), now, tz);
            if self.dispatch("expiry", sub.user_id, &sub.email, &m).await {
                if let Err(e) = self.store.set_expiry_notice(sub.user_id, user.expires_at.clone()).await {
                    tracing::error!(target: "notify", error = %e, "saving expiry marker failed");
                }
                sent += 1;
            }
        }
        sent
    }

    /// Admin "send test email"; provider errors surface.
    pub async fn send_test(&self, to: &str) -> Result<(), SendError> {
        let email = to.trim().to_lowercase();
        if !valid_email(&email) {
            return Err(SendError::BadAddress);
        }
        let result = self.send_email(&email, &templates::test(&self.brand())).await;
        self.log(None, &email, "test", result.as_ref().err().map(ToString::to_string)).await;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::epg::tests::user;

    #[test]
    fn subscription_validation() {
        let (email, o) = validate_subscription(&json!({"email": "  USER@Example.com ", "options": {"server": true}})).unwrap();
        assert_eq!(email, "user@example.com");
        assert_eq!(o, NotifyOptions { server: true, expiry: false, content: false, news: false, renewal: true });
        let long = format!("{}@example.com", "x".repeat(250));
        for e in ["", "nope", "a@b", "a b@c.d", long.as_str()] {
            assert!(validate_subscription(&json!({ "email": e })).is_err(), "{e}");
        }
    }

    #[test]
    fn cap_and_summary() {
        assert_eq!(cap_names(&["a".into(), "b".into()]), ["a", "b"]);
        let many: Vec<String> = (0..20).map(|i| format!("ch{i}")).collect();
        let capped = cap_names(&many);
        assert_eq!(capped.len(), 13);
        assert_eq!(capped[12], "…и ещё 8 позиций");
        assert_eq!(content_change_summary(&ContentChange::default()), None);
        let one = ContentChange { added_categories: vec!["Спорт".into()], ..ContentChange::default() };
        assert_eq!(content_change_summary(&one), Some(one));
    }

    #[test]
    fn content_change_template() {
        let change = ContentChange { added_categories: vec!["Спорт".into()], removed_channels: vec!["НТВ".into()], ..ContentChange::default() };
        let m = templates::content_change("Бренд", "Алиса", &change, "Про");
        assert!(m.subject.contains("изменения в списке каналов"));
        assert!(m.html.contains("Список каналов изменился") && m.html.contains("Спорт") && m.html.contains("НТВ"));
        assert!(m.text.contains("Добавлены категории: Спорт") && m.text.contains("Убраны каналы: НТВ"));
    }

    fn notify_cfg(provider: MailProvider) -> crate::config::Notify {
        crate::config::Notify {
            enabled: std::sync::atomic::AtomicBool::new(true),
            provider,
            api_key: "key123".into(),
            from: "from@x.io".into(),
            from_name: "Brand".into(),
            dry_run: false,
        }
    }

    #[test]
    fn provider_payloads() {
        let m = Message { subject: "S".into(), html: "<b>h</b>".into(), text: "t".into() };
        let brevo = build_provider_request(&notify_cfg(MailProvider::Brevo), "c@d.e", &m);
        assert!(brevo.url.contains("brevo"));
        assert_eq!(brevo.headers[0], ("api-key", "key123".to_owned()));
        assert_eq!(brevo.body["to"], json!([{ "email": "c@d.e" }]));
        assert_eq!(brevo.body["htmlContent"], "<b>h</b>");
        let resend = build_provider_request(&notify_cfg(MailProvider::Resend), "c@d.e", &m);
        assert!(resend.url.contains("resend"));
        assert_eq!(resend.headers[0], ("authorization", "Bearer key123".to_owned()));
        assert_eq!(resend.body["from"], "Brand <from@x.io>");
        assert_eq!(resend.body["to"], json!(["c@d.e"]));
    }

    #[test]
    fn templates_escape() {
        let tz = TimeZone::get("Europe/Tallinn").unwrap();
        let m = templates::expiry("Brand", "<script>alert(1)</script>", Some("2026-07-05"), Timestamp::now(), &tz);
        assert!(!m.html.contains("<script>") && m.html.contains("&lt;script&gt;"));
        assert!(m.subject.contains("скоро истекает"));
        let v = templates::verification("Brand", "http://h/sub/verify/tok123");
        assert!(v.html.contains("http://h/sub/verify/tok123") && v.text.contains("http://h/sub/verify/tok123"));
        let n = templates::newsletter("Бренд", "Новости <b>", "Первый\nабзац\n\n<script>x</script>", true);
        assert_eq!(n.subject, "Бренд: Важно — Новости <b>");
        assert!(!n.html.contains("<script>") && n.html.contains("Первый<br>абзац") && n.html.contains("&lt;script&gt;"));
        assert!(n.text.starts_with("ВАЖНО. Новости <b>"));
    }

    fn sub(user_id: i64, verified: bool, news: bool, expiry: bool, last: Option<&str>) -> Subscriber {
        Subscriber {
            user_id,
            email: format!("u{user_id}@x.io"),
            options: NotifyOptions { news, expiry, ..NotifyOptions::default() },
            verified,
            verify_token: None,
            created_at: String::new(),
            updated_at: String::new(),
            last_expiry_notice: last.map(Into::into),
        }
    }

    #[test]
    fn expiry_due_dedups_by_date() {
        let tz = TimeZone::get("Europe/Tallinn").unwrap();
        let now: Timestamp = "2026-07-01T12:00:00Z".parse().unwrap();
        let u = user("t", "u", Some("2026-07-05"), true, false);
        assert!(expiry_due(&u, &sub(1, true, false, true, None), now, &tz, 7));
        assert!(!expiry_due(&u, &sub(1, false, false, true, None), now, &tz, 7));
        assert!(!expiry_due(&u, &sub(1, true, false, true, Some("2026-07-05")), now, &tz, 7));
        let later = user("t", "u", Some("2026-07-07"), true, false);
        assert!(expiry_due(&later, &sub(1, true, false, true, Some("2026-07-05")), now, &tz, 7));
        assert!(!expiry_due(&u, &sub(1, true, false, false, None), now, &tz, 7));
        let far = user("t", "u", Some("2026-12-31"), true, false);
        assert!(!expiry_due(&far, &sub(1, true, false, true, None), now, &tz, 7));
    }

    #[test]
    fn newsletter_validation_and_recipients() {
        assert!(validate_newsletter(&json!({"body": "x"})).unwrap_err().contains("тему"));
        assert!(validate_newsletter(&json!({"subject": "Тема"})).unwrap_err().contains("текст"));
        assert!(validate_newsletter(&json!({"subject": "x".repeat(151), "body": "x"})).unwrap_err().contains("150"));
        let d = validate_newsletter(&json!({"subject": "  Плановые   работы ", "body": "Строка\r\nвторая\r\n\r\nНовый абзац", "important": "yes"})).unwrap();
        assert_eq!(d.subject, "Плановые работы");
        assert_eq!(d.body, "Строка\nвторая\n\nНовый абзац");
        assert!(!d.important);
        assert_eq!(d.audience, None);
        let aimed = validate_newsletter(&json!({"subject": "a", "body": "b", "audience": {"users": ["3", 3, "x"], "plans": ["pro"]}})).unwrap();
        assert_eq!(aimed.audience, Some(Audience { users: vec![3], plans: vec!["pro".into()] }));

        let mk = |id: i64, plan: &str| {
            let mut u = user("t", "u", None, true, false);
            u.user.id = id;
            u.user.plan_id = plan.into();
            u
        };
        let users = [mk(1, "pro"), mk(2, "std"), mk(3, "std"), mk(4, "std")];
        let subs = [sub(1, true, true, false, None), sub(2, true, true, false, None), sub(3, false, true, false, None), sub(4, true, false, false, None), sub(99, true, true, false, None)];
        let ids = |a: Option<Audience>| newsletter_recipients(a.as_ref(), &users, &subs).iter().map(|(u, _)| u.id).collect::<Vec<_>>();
        assert_eq!(ids(None), [1, 2]);
        assert_eq!(ids(Some(Audience { users: vec![], plans: vec!["pro".into()] })), [1]);
        assert_eq!(ids(Some(Audience { users: vec![2, 3], plans: vec![] })), [2]);
        assert_eq!(ids(Some(Audience::default())), Vec::<i64>::new());
    }
}
