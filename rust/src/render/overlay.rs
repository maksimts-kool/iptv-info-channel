//! The per-user channel visuals as SVG (rasterized by `render::raster`).
//! Frames: the brand intro, the account-specific body (card / renewal card /
//! plans grid), the global status board, and the device-limit notice. All use
//! a fixed 1280×720 viewBox scaled to the configured output size.
//!
//! On-screen text is Russian — keep it that way when editing.

use std::fmt::Write as _;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use qrcode::{Color, EcLevel, QrCode};

use super::status::{PROVIDER_COLOR, PROVIDER_LABEL, StatusState, StatusSummary, format_uptime};
use crate::core::util::{
    AccountStatus, account_status, days_left, format_date, format_price, format_time, local_date_string,
    parse_instant, period_label, plural_days, xml_escape,
};
use crate::data::model::{DecoratedUser, Incident, Severity};
use crate::news::notices::ProviderNotice;

/// What every frame needs to know about the output and "now".
#[derive(Debug, Clone, Copy)]
pub struct RenderCtx<'a> {
    pub width: u32,
    pub height: u32,
    pub now: Timestamp,
    pub tz: &'a TimeZone,
    pub expiring_threshold_days: i64,
}

/// Branding settings shown on the frames.
#[derive(Debug, Clone, Copy)]
pub struct Branding<'a> {
    pub brand: &'a str,
    pub tagline: &'a str,
}

/// A plan as the frames show it; `features` are the granted category names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanCard {
    pub id: String,
    pub name: String,
    pub price_cents: i64,
    pub currency: String,
    pub billing_period: String,
    pub features: Vec<String>,
}

/// JS-style number formatting for SVG attributes (`565`, `565.5`).
fn num(v: f64) -> String {
    format!("{v}")
}

const SHARED_DEFS: &str = r##"
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1224"/>
      <stop offset="55%" stop-color="#111a35"/>
      <stop offset="100%" stop-color="#1b2550"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="55%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>"##;

fn bg() -> String {
    let lines: String = (0..12).map(|i| format!(r#"<line x1="{x}" y1="0" x2="{x}" y2="720"/>"#, x = i * 110)).collect();
    format!(
        r##"
  <rect width="1280" height="720" fill="url(#bg)"/>
  <g opacity="0.05" stroke="#ffffff" stroke-width="1">
    {lines}
  </g>
  <rect x="0" y="0" width="1280" height="8" fill="url(#accent)"/>"##
    )
}

fn svg_doc(ctx: &RenderCtx<'_>, inner: &str) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="0 0 1280 720">{SHARED_DEFS}{}{inner}</svg>"#,
        ctx.width,
        ctx.height,
        bg()
    )
}

/// The bare channel background — the canvas of the media channel's pages.
/// `edges` returns only the top and bottom bands, fading toward the middle:
/// drawn OVER a scrolling page so lines glide in and out under the accent bar.
pub fn build_background_svg(ctx: &RenderCtx<'_>, edges: bool) -> String {
    if !edges {
        return svg_doc(ctx, "");
    }
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="0 0 1280 720">{SHARED_DEFS}
  <defs>
    <linearGradient id="edgeFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.07" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.15" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.85" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.93" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="1"/>
    </linearGradient>
    <mask id="edges"><rect width="1280" height="720" fill="url(#edgeFade)"/></mask>
  </defs>
  <g mask="url(#edges)">{}</g></svg>"##,
        ctx.width,
        ctx.height,
        bg()
    )
}

/// Shorten to `max` chars with a trailing ellipsis.
pub fn clip_text(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    let head: String = value.chars().take(max.saturating_sub(1).max(1)).collect();
    format!("{}…", head.trim())
}

/// Greedy word wrap; the last kept line ends in "…" when text is left over.
pub fn wrap_text(text: &str, max_chars: usize, max_lines: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let next = if current.is_empty() { word.to_owned() } else { format!("{current} {word}") };
        if next.chars().count() <= max_chars || current.is_empty() {
            current = next;
        } else {
            lines.push(std::mem::replace(&mut current, word.to_owned()));
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.len() <= max_lines {
        return lines.iter().map(|l| clip_text(l, max_chars)).collect();
    }
    let mut kept: Vec<String> = lines[..max_lines].to_vec();
    if let Some(last) = kept.last_mut() {
        *last = clip_text(&format!("{last} {}", lines[max_lines]), max_chars);
    }
    kept
}

fn logo_mark(brand: &str, cx: f64, cy: f64, size: f64) -> String {
    let initial = brand.trim().chars().next().map_or_else(|| "I".to_owned(), |c| c.to_uppercase().collect());
    let half = size / 2.0;
    format!(
        r##"
    <rect x="{}" y="{}" width="{}" height="{}" rx="{}" fill="url(#accent)" filter="url(#soft)"/>
    <text x="{}" y="{}" text-anchor="middle" fill="#0b1224" font-family="Inter, sans-serif" font-size="{}" font-weight="800">{}</text>"##,
        num(cx - half),
        num(cy - half),
        num(size),
        num(size),
        num(size * 0.26),
        num(cx),
        num(cy + size * 0.18),
        num(size * 0.55),
        xml_escape(&initial)
    )
}

/// A white QR panel (with caption) for `url`, quiet zone included so any
/// phone camera resolves it.
fn qr_panel_svg(url: &str, x: f64, y: f64, size: f64) -> String {
    let Ok(qr) = QrCode::with_error_correction_level(url, EcLevel::M) else { return String::new() };
    let count = qr.width();
    let colors = qr.to_colors();
    let pad = 18.0;
    let quiet = 4.0;
    let cell = size / (count as f64 + quiet * 2.0);
    let ox = x + pad + quiet * cell;
    let oy = y + pad + quiet * cell;
    let mut modules = String::new();
    for r in 0..count {
        for c in 0..count {
            if colors[r * count + c] == Color::Dark {
                let _ = write!(
                    modules,
                    r##"<rect x="{:.2}" y="{:.2}" width="{cell:.2}" height="{cell:.2}" fill="#0b1224"/>"##,
                    ox + c as f64 * cell,
                    oy + r as f64 * cell
                );
            }
        }
    }
    let panel_w = size + pad * 2.0;
    let panel_h = size + pad * 2.0 + 30.0;
    format!(
        r##"
    <g>
      <rect x="{}" y="{}" width="{}" height="{}" rx="18" fill="#ffffff" filter="url(#soft)"/>
      {modules}
      <text x="{}" y="{}" text-anchor="middle" fill="#0b1224" font-family="Inter, sans-serif" font-size="16" font-weight="700">Подписка на уведомления</text>
    </g>"##,
        num(x),
        num(y),
        num(panel_w),
        num(panel_h),
        num(x + panel_w / 2.0),
        num(y + size + pad + 22.0)
    )
}

/// Intro slide 1: the brand reveal. With `subscribe_url` (notifications on)
/// a QR sign-up code is added; `None` leaves the slide as it always was.
pub fn build_brand_slide1_svg(ctx: &RenderCtx<'_>, b: Branding<'_>, subscribe_url: Option<&str>) -> String {
    let brand = xml_escape(b.brand);
    let Some(url) = subscribe_url else {
        return svg_doc(
            ctx,
            &format!(
                r##"
    <rect width="1280" height="720" fill="url(#glow)"/>
    {}
    <text x="640" y="470" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="72" font-weight="800" letter-spacing="-1">{brand}</text>
    <rect x="560" y="500" width="160" height="6" rx="3" fill="url(#accent)"/>"##,
                logo_mark(b.brand, 640.0, 300.0, 150.0)
            ),
        );
    };
    svg_doc(
        ctx,
        &format!(
            r##"
    <rect width="1280" height="720" fill="url(#glow)"/>
    {}
    <text x="640" y="300" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="58" font-weight="800" letter-spacing="-1">{brand}</text>
    <rect x="588" y="326" width="104" height="6" rx="3" fill="url(#accent)"/>
    <text x="640" y="394" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">Наведите камеру телефона на QR-код, чтобы подписаться на уведомления</text>
    {}"##,
            logo_mark(b.brand, 640.0, 170.0, 120.0),
            qr_panel_svg(url, 522.0, 414.0, 200.0)
        ),
    )
}

fn user_status(ctx: &RenderCtx<'_>, user: &DecoratedUser) -> AccountStatus {
    account_status(user.active, user.expires_at.as_deref(), ctx.expiring_threshold_days, ctx.now, ctx.tz)
}

fn price_with_period(cents: i64, currency: &str, period: &str, period_size: &str) -> String {
    let p = period_label(period);
    let tail = if p.is_empty() {
        String::new()
    } else {
        format!(r#"<tspan font-size="{period_size}" font-weight="600">{}</tspan>"#, xml_escape(p))
    };
    format!("{}{tail}", xml_escape(&format_price(cents, currency)))
}

/// The looping info card (user details).
pub fn build_card_svg(ctx: &RenderCtx<'_>, user: &DecoratedUser, b: Branding<'_>, plans: &[PlanCard]) -> String {
    let status = user_status(ctx, user);
    let d = days_left(user.expires_at.as_deref(), ctx.now, ctx.tz);
    let days_text = match d {
        None => "бессрочно".to_owned(),
        Some(d) if d < 0 => format!("{} {} назад", d.abs(), plural_days(d)),
        Some(d) => format!("{d} {}", plural_days(d)),
    };
    let brand = xml_escape(b.brand);
    let tagline = xml_escape(b.tagline);
    let status_font = if status.label().chars().count() > 10 { 27 } else { 32 };

    // In the final days the card swaps its lower half for a renewal strip.
    if status == AccountStatus::Expiring {
        return build_renewing_card_svg(ctx, user, plans, &brand, &tagline, status, d.unwrap_or(0), status_font);
    }
    let today = format_date(Some(&local_date_string(ctx.now, ctx.tz)));
    svg_doc(
        ctx,
        &format!(
            r##"
  <!-- Header -->
  <text x="80" y="92" fill="#ffffff" font-family="Inter, sans-serif" font-size="40" font-weight="700" letter-spacing="-0.5">{brand}</text>
  <text x="80" y="130" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">{tagline}</text>

  <!-- Card panel -->
  <rect x="64" y="170" width="1152" height="470" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>

  <!-- Account -->
  <text x="104" y="248" fill="#7f93b5" font-family="Inter, sans-serif" font-size="22" letter-spacing="2">АККАУНТ</text>
  <text x="104" y="312" fill="#ffffff" font-family="Inter, sans-serif" font-size="58" font-weight="700" letter-spacing="-1">{username}</text>

  <!-- Status banner -->
  <rect x="820" y="214" width="356" height="86" rx="16" fill="{color}"/>
  <circle cx="860" cy="257" r="12" fill="#ffffff" opacity="0.9"/>
  <text x="888" y="267" fill="#ffffff" font-family="Inter, sans-serif" font-size="{status_font}" font-weight="800">{label}</text>

  <!-- Divider -->
  <line x1="104" y1="372" x2="1176" y2="372" stroke="#24345f" stroke-width="1.5"/>

  <!-- Info grid -->
  <g font-family="Inter, sans-serif">
    <text x="104" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ТАРИФ</text>
    <text x="104" y="492" fill="#ffffff" font-size="44" font-weight="700">{plan}</text>

    <text x="464" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ЦЕНА</text>
    <text x="464" y="492" fill="#7dd3fc" font-size="44" font-weight="700">{price}</text>

    <text x="824" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ИСТЕКАЕТ</text>
    <text x="824" y="492" fill="#ffffff" font-size="44" font-weight="700">{expires}</text>

    <text x="104" y="566" fill="#7f93b5" font-size="22" letter-spacing="2">ОСТАЛОСЬ ВРЕМЕНИ</text>
    <text x="104" y="612" fill="{color}" font-size="40" font-weight="800">{days}</text>
{devices}
  </g>

  <!-- Footer -->
  <text x="64" y="690" fill="#5c6e91" font-family="Inter, sans-serif" font-size="18">Обновлено {today} · Канал обновляется ежедневно</text>"##,
            username = xml_escape(&user.username),
            color = status.color(),
            label = status.label(),
            plan = xml_escape(&user.plan_name),
            price = price_with_period(user.price_cents, &user.currency, &user.billing_period, "26"),
            expires = xml_escape(&format_date(user.expires_at.as_deref())),
            days = xml_escape(&days_text),
            devices = device_limit_cell(user.device_limit),
            today = xml_escape(&today),
        ),
    )
}

/// The device cap, shown only when there is one.
fn device_limit_cell(limit: i64) -> String {
    if limit <= 0 {
        return String::new();
    }
    format!(
        r##"
    <text x="464" y="566" fill="#7f93b5" font-size="22" letter-spacing="2">УСТРОЙСТВА</text>
    <text x="464" y="612" fill="#ffffff" font-size="40" font-weight="800">до {limit}<tspan dx="12" font-size="24" font-weight="600" fill="#9fb3d1">одновременно</tspan></text>"##
    )
}

/// "через минуту" / "через 90 сек." — how long a closed device keeps its slot.
pub fn slot_free_text(idle_seconds: u64) -> String {
    let s = idle_seconds.max(1);
    if s == 60 {
        "через минуту".to_owned()
    } else if s % 60 == 0 {
        format!("через {} мин.", s / 60)
    } else {
        format!("через {s} сек.")
    }
}

/// The one frame of the global "too many devices" loop.
pub fn build_device_limit_svg(ctx: &RenderCtx<'_>, brand: &str, idle_seconds: u64) -> String {
    let screen = |x: f64, y: f64, w: f64, h: f64, fill: &str| {
        format!(
            r##"
    <rect x="{}" y="{}" width="{}" height="{}" rx="10" fill="{fill}" stroke="#ffffff" stroke-opacity="0.85" stroke-width="5"/>
    <rect x="{}" y="{}" width="36" height="10" rx="3" fill="#ffffff" fill-opacity="0.85"/>"##,
            num(x),
            num(y),
            num(w),
            num(h),
            num(x + w / 2.0 - 18.0),
            num(y + h + 4.0)
        )
    };
    svg_doc(
        ctx,
        &format!(
            r##"
  <text x="80" y="92" fill="#ffffff" font-family="Inter, sans-serif" font-size="40" font-weight="700" letter-spacing="-0.5">{brand}</text>
  <rect x="64" y="150" width="1152" height="500" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>
  <rect x="64" y="150" width="1152" height="10" rx="5" fill="#f97316"/>
  <g>
    {}
    {}
    {}
    <line x1="700" y1="300" x2="750" y2="350" stroke="#ffffff" stroke-width="9" stroke-linecap="round"/>
    <line x1="750" y1="300" x2="700" y2="350" stroke="#ffffff" stroke-width="9" stroke-linecap="round"/>
  </g>
  <text x="640" y="462" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="54" font-weight="800" letter-spacing="-1">Превышен лимит устройств</text>
  <text x="640" y="518" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="26">Подписка уже открыта на всех устройствах, которые разрешает ваш тариф.</text>
  <text x="640" y="560" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="26">Остановите просмотр на другом устройстве и откройте канал снова {}.</text>
  <text x="640" y="614" text-anchor="middle" fill="#7f93b5" font-family="Inter, sans-serif" font-size="20">Сколько устройств входит в тариф — на канале «Информация».</text>"##,
            screen(470.0, 214.0, 150.0, 100.0, "#1b2550"),
            screen(560.0, 244.0, 150.0, 100.0, "#24345f"),
            screen(650.0, 274.0, 150.0, 100.0, "#f97316"),
            xml_escape(&slot_free_text(idle_seconds)),
            brand = xml_escape(brand),
        ),
    )
}

fn compact_plan_chip(plan: &PlanCard, x: f64, y: f64, w: f64, h: f64, current: bool) -> String {
    let name_chars = (((w - 28.0) / 13.0).floor() as usize).max(8);
    let tag = if current {
        format!(
            r##"<text x="{}" y="{}" text-anchor="end" fill="#38bdf8" font-size="14" font-weight="700" letter-spacing="1">ВАШ ТАРИФ</text>"##,
            num(x + w - 16.0),
            num(y + 26.0)
        )
    } else {
        String::new()
    };
    format!(
        r##"
    <g font-family="Inter, sans-serif">
      <rect x="{}" y="{}" width="{}" height="{}" rx="14" fill="#131f3d" stroke="{}" stroke-width="{}"/>
      <text x="{}" y="{}" fill="#ffffff" font-size="21" font-weight="700">{}</text>
      <text x="{}" y="{}" fill="#7dd3fc" font-size="27" font-weight="800">{}</text>
      {tag}
    </g>"##,
        num(x),
        num(y),
        num(w),
        num(h),
        if current { "#38bdf8" } else { "#2b3d68" },
        if current { "2.5" } else { "1.5" },
        num(x + 18.0),
        num(y + 30.0),
        xml_escape(&clip_text(&plan.name, name_chars)),
        num(x + 18.0),
        num(y + 60.0),
        price_with_period(plan.price_cents, &plan.currency, &plan.billing_period, "17"),
    )
}

#[allow(clippy::too_many_arguments)]
fn build_renewing_card_svg(
    ctx: &RenderCtx<'_>,
    user: &DecoratedUser,
    plans: &[PlanCard],
    brand: &str,
    tagline: &str,
    status: AccountStatus,
    d: i64,
    status_font: i32,
) -> String {
    let urgent = if d == 0 { "Последний день".to_owned() } else { format!("{d} {}", plural_days(d)) };
    let visible = &plans[..plans.len().min(4)];
    let (grid_x, grid_w, chip_h, chip_y, gap) = (104.0, 1072.0, 74.0, 548.0, 16.0);
    let n = visible.len() as f64;
    let chip_w = if visible.is_empty() { grid_w } else { (grid_w - gap * (n - 1.0)) / n };
    let chips = if visible.is_empty() {
        format!(
            r##"<text x="{}" y="{}" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">Свяжитесь с администратором для продления подписки</text>"##,
            num(grid_x),
            num(chip_y + 44.0)
        )
    } else {
        visible
            .iter()
            .enumerate()
            .map(|(i, p)| compact_plan_chip(p, grid_x + i as f64 * (chip_w + gap), chip_y, chip_w, chip_h, p.id == user.plan_id))
            .collect()
    };
    let today = format_date(Some(&local_date_string(ctx.now, ctx.tz)));
    svg_doc(
        ctx,
        &format!(
            r##"
  <!-- Header -->
  <text x="80" y="92" fill="#ffffff" font-family="Inter, sans-serif" font-size="40" font-weight="700" letter-spacing="-0.5">{brand}</text>
  <text x="80" y="130" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">{tagline}</text>

  <!-- Card panel -->
  <rect x="64" y="170" width="1152" height="470" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>

  <!-- Account -->
  <text x="104" y="232" fill="#7f93b5" font-family="Inter, sans-serif" font-size="22" letter-spacing="2">АККАУНТ</text>
  <text x="104" y="294" fill="#ffffff" font-family="Inter, sans-serif" font-size="54" font-weight="700" letter-spacing="-1">{username}</text>

  <!-- Status banner -->
  <rect x="820" y="200" width="356" height="86" rx="16" fill="{color}"/>
  <circle cx="860" cy="243" r="12" fill="#ffffff" opacity="0.9"/>
  <text x="888" y="253" fill="#ffffff" font-family="Inter, sans-serif" font-size="{status_font}" font-weight="800">{label}</text>

  <!-- Divider -->
  <line x1="104" y1="338" x2="1176" y2="338" stroke="#24345f" stroke-width="1.5"/>

  <!-- Condensed info row -->
  <g font-family="Inter, sans-serif">
    <text x="104" y="386" fill="#7f93b5" font-size="20" letter-spacing="2">ТАРИФ</text>
    <text x="104" y="434" fill="#ffffff" font-size="38" font-weight="700">{plan}</text>

    <text x="520" y="386" fill="#7f93b5" font-size="20" letter-spacing="2">ИСТЕКАЕТ</text>
    <text x="520" y="434" fill="#ffffff" font-size="38" font-weight="700">{expires}</text>

    <text x="880" y="386" fill="#7f93b5" font-size="20" letter-spacing="2">ОСТАЛОСЬ</text>
    <text x="880" y="434" fill="{color}" font-size="38" font-weight="800">{urgent}</text>
  </g>

  <!-- Renewal strip -->
  <text x="104" y="510" fill="#38bdf8" font-family="Inter, sans-serif" font-size="24" font-weight="800" letter-spacing="1">ПРОДЛИТЕ ПОДПИСКУ</text>
  {chips}

  <!-- Footer -->
  <text x="64" y="690" fill="#5c6e91" font-family="Inter, sans-serif" font-size="18">Обновлено {today} · Свяжитесь с администратором, чтобы продлить</text>"##,
            username = xml_escape(&clip_text(&user.username, 22)),
            color = status.color(),
            label = status.label(),
            plan = xml_escape(&clip_text(&user.plan_name, 16)),
            expires = xml_escape(&format_date(user.expires_at.as_deref())),
            urgent = xml_escape(&urgent),
            today = xml_escape(&today),
        ),
    )
}

fn plan_grid_layout(count: usize) -> (usize, usize) {
    match count {
        0..=4 => (count.max(1), 1),
        5 | 6 => (3, 2),
        _ => (4, count.div_ceil(4)),
    }
}

/// Header framing of the full plans grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlansVariant {
    /// Red "ПОДПИСКА ИСТЕКЛА".
    Expired,
    /// Orange "ПОСЛЕДНИЙ ДЕНЬ" — the account still works today.
    LastDay,
}

/// Expired accounts (and the final valid day) see the available plans
/// instead of the details card.
pub fn build_expired_plans_svg(
    ctx: &RenderCtx<'_>,
    user: &DecoratedUser,
    plans: &[PlanCard],
    brand: &str,
    variant: PlansVariant,
) -> String {
    let (badge, badge_color, heading, sub) = match variant {
        PlansVariant::Expired => (
            "ПОДПИСКА ИСТЕКЛА",
            "#dc2626",
            format!("{}, выберите новый тариф", clip_text(&user.username, 34)),
            "Доступные планы для продления подписки",
        ),
        PlansVariant::LastDay => (
            "ПОСЛЕДНИЙ ДЕНЬ",
            "#d97706",
            format!("{}, продлите подписку", clip_text(&user.username, 34)),
            "Подписка истекает сегодня — выберите тариф, чтобы не потерять доступ",
        ),
    };
    let visible = &plans[..plans.len().min(12)];
    let (columns, rows) = plan_grid_layout(visible.len());
    let (cols_f, rows_f) = (columns as f64, rows as f64);
    let gap = if rows == 1 { 18.0 } else { 14.0 };
    let (grid_x, grid_y, grid_w, grid_h) = (64.0, 218.0, 1152.0, 400.0);
    let card_w = (grid_w - gap * (cols_f - 1.0)) / cols_f;
    let card_h = (grid_h - gap * (rows_f - 1.0)) / rows_f;
    let compact = card_h < 250.0;
    let feature_font: f64 = if compact {
        16.0
    } else if columns >= 4 {
        18.0
    } else {
        21.0
    };
    let feature_line = if compact { 27.0 } else { 38.0 };
    let feature_start = if compact { 112.0 } else { 184.0 };
    let max_rows = (((card_h - feature_start - 18.0) / feature_line).floor() + 1.0).max(0.0) as usize;
    let max_chars = (((card_w - 58.0) / (feature_font * 0.56)).floor() as usize).max(14);

    let mut cards = String::new();
    for (index, plan) in visible.iter().enumerate() {
        let x = grid_x + (index % columns) as f64 * (card_w + gap);
        let y = grid_y + (index / columns) as f64 * (card_h + gap);
        let current = plan.id == user.plan_id;
        let name_size: f64 = if compact {
            24.0
        } else if columns >= 4 {
            26.0
        } else {
            31.0
        };
        let price_size: f64 = if compact {
            27.0
        } else if columns >= 4 {
            33.0
        } else {
            39.0
        };
        let name_chars = (((card_w - 40.0) / (name_size * 0.58)).floor() as usize).max(8);
        let all = &plan.features;
        let overflow = all.len() > max_rows && max_rows > 0;
        let shown = if overflow { max_rows - 1 } else { max_rows };
        let features = &all[..all.len().min(shown)];
        let hidden = all.len() - features.len();

        let mut rows_svg = String::new();
        for (fi, feature) in features.iter().enumerate() {
            let fy = y + feature_start + fi as f64 * feature_line;
            let _ = write!(
                rows_svg,
                r##"
        <circle cx="{}" cy="{}" r="{}" fill="#38bdf8"/>
        <text x="{}" y="{}" fill="#c7d5eb" font-size="{}">{}</text>"##,
                num(x + 27.0),
                num(fy - 6.0),
                if compact { 4 } else { 5 },
                num(x + 42.0),
                num(fy),
                num(feature_font),
                xml_escape(&clip_text(feature, max_chars))
            );
        }
        let more = if hidden > 0 && max_rows > 0 {
            format!(
                r##"<text x="{}" y="{}" fill="#7f93b5" font-size="{}">+{hidden} ещё</text>"##,
                num(x + 24.0),
                num(y + feature_start + features.len() as f64 * feature_line),
                num(feature_font)
            )
        } else {
            String::new()
        };
        let divider = if compact {
            String::new()
        } else {
            format!(
                r##"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="#2b3d68" stroke-width="1"/>"##,
                num(x + 24.0),
                num(y + 146.0),
                num(x + card_w - 24.0),
                num(y + 146.0)
            )
        };
        let body = if !rows_svg.is_empty() {
            rows_svg
        } else if compact {
            String::new()
        } else {
            format!(
                r##"<text x="{}" y="{}" fill="#7f93b5" font-size="{}">Подробности у администратора</text>"##,
                num(x + 24.0),
                num(y + feature_start),
                num(feature_font)
            )
        };
        let period = period_label(&plan.billing_period);
        let period_svg = if period.is_empty() {
            String::new()
        } else {
            format!(
                r#"<tspan font-size="{}" font-weight="600">{}</tspan>"#,
                (price_size * 0.62).round(),
                xml_escape(period)
            )
        };
        let _ = write!(
            cards,
            r##"
      <g font-family="Inter, sans-serif">
        <rect x="{}" y="{}" width="{}" height="{}" rx="{}" fill="#131f3d" stroke="{}" stroke-width="{}"/>
        <text x="{}" y="{}" fill="#ffffff" font-size="{}" font-weight="700">{}</text>
        <text x="{}" y="{}" fill="#7dd3fc" font-size="{}" font-weight="800">{}{period_svg}</text>
        {divider}
        {body}
        {more}
      </g>"##,
            num(x),
            num(y),
            num(card_w),
            num(card_h),
            if compact { 14 } else { 20 },
            if current { "#38bdf8" } else { "#2b3d68" },
            if current { "3" } else { "1.5" },
            num(x + 24.0),
            num(y + if compact { 43.0 } else { 58.0 }),
            num(name_size),
            xml_escape(&clip_text(&plan.name, name_chars)),
            num(x + 24.0),
            num(y + if compact { 82.0 } else { 119.0 }),
            num(price_size),
            xml_escape(&format_price(plan.price_cents, &plan.currency)),
        );
    }

    let empty = if visible.is_empty() {
        r##"
    <rect x="360" y="280" width="560" height="210" rx="22" fill="#131f3d" stroke="#2b3d68" stroke-width="1.5"/>
    <text x="640" y="365" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="34" font-weight="700">Тарифы скоро появятся</text>
    <text x="640" y="415" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">Свяжитесь с администратором для продления</text>"##
    } else {
        ""
    };
    let extra = plans.len() - visible.len();
    let extra_text = if extra > 0 { format!(" · Ещё тарифов: {extra}") } else { String::new() };
    let badge_w = 40.0 + badge.chars().count() as f64 * 15.0;
    let badge_x = 1216.0 - badge_w;
    svg_doc(
        ctx,
        &format!(
            r##"
    <text x="64" y="76" fill="#ffffff" font-family="Inter, sans-serif" font-size="34" font-weight="700" letter-spacing="-0.5">{brand}</text>
    <rect x="{bx}" y="42" width="{bw}" height="55" rx="14" fill="{badge_color}"/>
    <text x="{bc}" y="79" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="24" font-weight="800">{badge}</text>
    <text x="64" y="146" fill="#ffffff" font-family="Inter, sans-serif" font-size="42" font-weight="800" letter-spacing="-0.8">{heading}</text>
    <text x="64" y="184" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">{sub}</text>
    {cards}
    {empty}
    <text x="64" y="684" fill="#6f83a6" font-family="Inter, sans-serif" font-size="18">Свяжитесь с администратором, чтобы активировать выбранный тариф{extra_text}</text>"##,
            brand = xml_escape(brand),
            bx = num(badge_x),
            bw = num(badge_w),
            bc = num(badge_x + badge_w / 2.0),
            heading = xml_escape(&heading),
            sub = xml_escape(sub),
        ),
    )
}

/// Routes the body: plans grid when expired or on the final valid day,
/// otherwise the (possibly renewing) details card.
pub fn build_body_svg(ctx: &RenderCtx<'_>, user: &DecoratedUser, plans: &[PlanCard], b: Branding<'_>) -> String {
    match user_status(ctx, user) {
        AccountStatus::Expired => build_expired_plans_svg(ctx, user, plans, b.brand, PlansVariant::Expired),
        AccountStatus::Expiring if days_left(user.expires_at.as_deref(), ctx.now, ctx.tz) == Some(0) => {
            build_expired_plans_svg(ctx, user, plans, b.brand, PlansVariant::LastDay)
        }
        _ => build_card_svg(ctx, user, b, plans),
    }
}

// ---- Status board slide ----

fn status_icon(severity: Severity, cx: f64, cy: f64, r: f64) -> String {
    let color = severity.color();
    if severity == Severity::Operational {
        return format!(
            r##"<circle cx="{}" cy="{}" r="{}" fill="{color}"/>
      <path d="M{} {} L{} {} L{} {}" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>"##,
            num(cx),
            num(cy),
            num(r),
            num(cx - 16.0),
            num(cy),
            num(cx - 5.0),
            num(cy + 12.0),
            num(cx + 17.0),
            num(cy - 13.0)
        );
    }
    format!(
        r##"<circle cx="{}" cy="{}" r="{}" fill="{color}"/>
    <rect x="{}" y="{}" width="6" height="22" rx="3" fill="#ffffff"/>
    <circle cx="{}" cy="{}" r="4" fill="#ffffff"/>"##,
        num(cx),
        num(cy),
        num(r),
        num(cx - 3.0),
        num(cy - 17.0),
        num(cx),
        num(cy + 14.0)
    )
}

fn incident_range(inc: &Incident) -> String {
    let start = format_date(inc.starts_on.as_deref());
    match inc.ends_on.as_deref().filter(|e| !e.is_empty()) {
        None => format!("с {start}"),
        Some(end) if Some(end) == inc.starts_on.as_deref() => start,
        Some(end) => format!("{start} — {}", format_date(Some(end))),
    }
}

/// A megaphone in a blue disc; the glyph is drawn for r=30 and scaled.
fn megaphone_icon(cx: f64, cy: f64, r: f64) -> String {
    let s = (r / 30.0 * 1000.0).round() / 1000.0;
    format!(
        r##"<circle cx="{}" cy="{}" r="{}" fill="{PROVIDER_COLOR}"/>
    <g transform="translate({} {}) scale({})">
      <path d="M-13 -6 L-4 -6 L8 -14 L8 14 L-4 6 L-13 6 Z" fill="#ffffff" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      <rect x="-10" y="5" width="6" height="10" rx="2" fill="#ffffff"/>
      <path d="M14 -7 Q20 0 14 7" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
    </g>"##,
        num(cx),
        num(cy),
        num(r),
        num(((cx - 2.0 * s) * 100.0).round() / 100.0),
        num(cy),
        num(s)
    )
}

fn notice_when(notice: &ProviderNotice, tz: &TimeZone) -> String {
    parse_instant(&notice.published_at).map_or_else(String::new, |t| {
        format!("{} · {}", format_date(Some(&local_date_string(t, tz))), format_time(t, tz))
    })
}

const EVENTS_TOP: f64 = 404.0;
const EVENTS_BOTTOM: f64 = 672.0;
const EVENT_GAP: f64 = 12.0;
const BODY_LINE: f64 = 30.0;

enum EventKind<'a> {
    Incident(&'a Incident),
    Provider(&'a ProviderNotice),
}

struct EventItem<'a> {
    kind: EventKind<'a>,
    lines: usize,
    max_lines: usize,
}

fn event_height(item: &EventItem<'_>) -> f64 {
    62.0 + if item.lines > 0 { item.lines as f64 * BODY_LINE + 8.0 } else { 0.0 }
}

fn events_height(items: &[&EventItem<'_>]) -> f64 {
    items.iter().enumerate().map(|(i, it)| event_height(it) + if i > 0 { EVENT_GAP } else { 0.0 }).sum()
}

fn sorted_incidents(list: &[Incident]) -> Vec<&Incident> {
    let mut v: Vec<&Incident> = list.iter().collect();
    v.sort_by_key(|i| std::cmp::Reverse(i.severity()));
    v
}

/// One list for both kinds: our incidents worst-first, then the provider's
/// notices newest-first. A provider notice always keeps a card, and spare
/// room goes to its text. Returns the shown items and the hidden count.
fn layout_events<'a>(summary: &'a StatusSummary) -> (Vec<EventItem<'a>>, usize) {
    let mut items: Vec<EventItem<'a>> = sorted_incidents(&summary.active_incidents)
        .into_iter()
        .map(|inc| {
            let l = usize::from(!inc.note.is_empty());
            EventItem { kind: EventKind::Incident(inc), lines: l, max_lines: l }
        })
        .collect();
    items.extend(summary.provider_notices.iter().map(|n| EventItem {
        kind: EventKind::Provider(n),
        lines: 1,
        max_lines: wrap_text(&n.body, 84, 4).len().clamp(1, 3),
    }));
    let total = items.len();
    let budget = EVENTS_BOTTOM - EVENTS_TOP;

    let mut shown: Vec<usize> = Vec::new();
    for i in 0..items.len() {
        let mut probe: Vec<&EventItem<'_>> = shown.iter().map(|&j| &items[j]).collect();
        probe.push(&items[i]);
        if events_height(&probe) > budget {
            break;
        }
        shown.push(i);
    }
    if let Some(first) = items.iter().position(|it| matches!(it.kind, EventKind::Provider(_)))
        && !shown.contains(&first)
    {
        loop {
            let mut probe: Vec<&EventItem<'_>> = shown.iter().map(|&j| &items[j]).collect();
            probe.push(&items[first]);
            if shown.is_empty() || events_height(&probe) <= budget {
                break;
            }
            shown.pop();
        }
        shown.push(first);
    }
    for &i in &shown {
        loop {
            let probe: Vec<&EventItem<'_>> = shown.iter().map(|&j| &items[j]).collect();
            let grow = items[i].lines < items[i].max_lines
                && matches!(items[i].kind, EventKind::Provider(_))
                && events_height(&probe) + BODY_LINE <= budget;
            if !grow {
                break;
            }
            items[i].lines += 1;
        }
    }
    let hidden = total - shown.len();
    let mut taken: Vec<Option<EventItem<'a>>> = items.into_iter().map(Some).collect();
    (shown.into_iter().filter_map(|i| taken[i].take()).collect(), hidden)
}

fn event_card(item: &EventItem<'_>, top: f64, tz: &TimeZone) -> String {
    let h = event_height(item);
    match item.kind {
        EventKind::Incident(inc) => {
            let sev = inc.severity().unwrap_or(Severity::Degraded);
            let note = if item.lines > 0 {
                format!(
                    r##"<text x="132" y="{}" fill="#b8c6e0" font-family="Inter, sans-serif" font-size="21">{}</text>"##,
                    num(top + 74.0),
                    xml_escape(&clip_text(&inc.note, 88))
                )
            } else {
                String::new()
            };
            format!(
                r##"
    <rect x="64" y="{t}" width="1152" height="{h}" rx="18" fill="#131f3d" stroke="{c}" stroke-width="2"/>
    <circle cx="104" cy="{t31}" r="10" fill="{c}"/>
    <text x="132" y="{t40}" fill="#ffffff" font-family="Inter, sans-serif" font-size="26" font-weight="700">{title}</text>
    <text x="1184" y="{t40}" text-anchor="end" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="19">{meta}</text>
    {note}"##,
                t = num(top),
                h = num(h),
                c = sev.color(),
                t31 = num(top + 31.0),
                t40 = num(top + 40.0),
                title = xml_escape(&clip_text(&inc.title, 40)),
                meta = xml_escape(&format!("{} · {}", sev.label(), incident_range(inc))),
            )
        }
        EventKind::Provider(notice) => {
            let body: String = wrap_text(&notice.body, 84, item.lines)
                .iter()
                .enumerate()
                .map(|(i, line)| {
                    format!(
                        r##"<text x="132" y="{}" fill="#dbeafe" font-family="Inter, sans-serif" font-size="21">{}</text>"##,
                        num(top + 74.0 + i as f64 * BODY_LINE),
                        xml_escape(line)
                    )
                })
                .collect();
            format!(
                r##"
    <rect x="64" y="{t}" width="1152" height="{h}" rx="18" fill="#0c1a3a" stroke="#3b82f6" stroke-width="2"/>
    {icon}
    <text x="132" y="{t40}" fill="#ffffff" font-family="Inter, sans-serif" font-size="26" font-weight="700">{title}</text>
    <text x="1184" y="{t40}" text-anchor="end" fill="#93c5fd" font-family="Inter, sans-serif" font-size="19">{meta}</text>
    {body}"##,
                t = num(top),
                h = num(h),
                icon = megaphone_icon(104.0, top + 31.0, 17.0),
                t40 = num(top + 40.0),
                title = xml_escape(&clip_text(&notice.headline, 40)),
                meta = xml_escape(&format!("Провайдер · {}", notice_when(notice, tz))),
            )
        }
    }
}

fn pill(summary: &StatusSummary) -> (&'static str, &'static str) {
    match summary.state {
        StatusState::Provider => (PROVIDER_COLOR, PROVIDER_LABEL),
        StatusState::Operational => (Severity::Operational.color(), Severity::Operational.label()),
        StatusState::Degraded => (Severity::Degraded.color(), Severity::Degraded.label()),
        StatusState::Outage => (Severity::Outage.color(), Severity::Outage.label()),
    }
}

fn state_severity(state: StatusState) -> Severity {
    match state {
        StatusState::Degraded => Severity::Degraded,
        StatusState::Outage => Severity::Outage,
        StatusState::Operational | StatusState::Provider => Severity::Operational,
    }
}

fn bars(summary: &StatusSummary, y: f64, height: f64) -> String {
    let n = summary.days.len().max(1) as f64;
    let width = (1072.0 - 2.0 * (n - 1.0)) / n;
    summary
        .days
        .iter()
        .enumerate()
        .map(|(i, day)| {
            format!(
                r#"<rect x="{:.2}" y="{}" width="{width:.2}" height="{}" rx="2" fill="{}"/>"#,
                104.0 + i as f64 * (width + 2.0),
                num(y),
                num(height),
                day.color
            )
        })
        .collect()
}

/// The status slide once the provider has something to say: a condensed
/// board on top, one event list underneath.
fn build_status_with_events_svg(ctx: &RenderCtx<'_>, summary: &StatusSummary, brand: &str) -> String {
    let provider = summary.state == StatusState::Provider;
    let (pill_color, pill_label) = pill(summary);
    let pill_w = 60.0 + pill_label.chars().count() as f64 * 14.0;
    let pill_x = 1176.0 - pill_w;
    let (shown, hidden) = layout_events(summary);
    let mut top = EVENTS_TOP;
    let mut cards = String::new();
    for item in &shown {
        cards.push_str(&event_card(item, top, ctx.tz));
        top += event_height(item) + EVENT_GAP;
    }
    let more = if hidden > 0 {
        format!(
            r##"<text x="1216" y="700" text-anchor="end" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="18">Ещё событий: {hidden}</text>"##
        )
    } else {
        String::new()
    };
    let icon = if provider { megaphone_icon(112.0, 86.0, 30.0) } else { status_icon(state_severity(summary.state), 112.0, 86.0, 30.0) };
    svg_doc(
        ctx,
        &format!(
            r##"
    {icon}
    <text x="160" y="96" fill="#ffffff" font-family="Inter, sans-serif" font-size="40" font-weight="800" letter-spacing="-0.5">{label}</text>
    <text x="160" y="130" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="20">Аптайм {uptime} за 90 дней · обновлено {date}</text>

    <rect x="64" y="160" width="1152" height="222" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>
    <text x="104" y="222" fill="#ffffff" font-family="Inter, sans-serif" font-size="28" font-weight="700">{brand}</text>
    <rect x="{px}" y="190" width="{pw}" height="40" rx="12" fill="{pill_color}"/>
    <circle cx="{pc}" cy="210" r="7" fill="#ffffff" opacity="0.9"/>
    <text x="{pt}" y="217" fill="#ffffff" font-family="Inter, sans-serif" font-size="20" font-weight="700">{pill_label}</text>

    {bars}
    <text x="104" y="352" fill="#6f83a6" font-family="Inter, sans-serif" font-size="16">90 дней назад</text>
    <text x="1176" y="352" text-anchor="end" fill="#6f83a6" font-family="Inter, sans-serif" font-size="16">Сегодня</text>

    {cards}

    <text x="64" y="700" fill="#5c6e91" font-family="Inter, sans-serif" font-size="18">Состояние сервиса · обновляется ежедневно · провайдер — автоматически</text>
    {more}"##,
            label = xml_escape(summary.label),
            uptime = xml_escape(&format_uptime(summary.uptime_pct)),
            date = xml_escape(&format_date(Some(&local_date_string(ctx.now, ctx.tz)))),
            brand = xml_escape(brand),
            px = num(pill_x),
            pw = num(pill_w),
            pc = num(pill_x + 22.0),
            pt = num(pill_x + 38.0),
            pill_label = xml_escape(pill_label),
            bars = bars(summary, 266.0, 54.0),
        ),
    )
}

/// The status slide from a [`StatusSummary`]. With provider notices they join
/// our incidents in one event list; without, the classic board.
pub fn build_status_slide_svg(ctx: &RenderCtx<'_>, summary: &StatusSummary, brand: &str) -> String {
    if !summary.provider_notices.is_empty() {
        return build_status_with_events_svg(ctx, summary, brand);
    }
    let severity = state_severity(summary.state);
    let (pill_color, pill_label) = (severity.color(), severity.label());
    let pill_w = 64.0 + pill_label.chars().count() as f64 * 15.0;
    let pill_x = 1176.0 - pill_w;
    let active = sorted_incidents(&summary.active_incidents);
    let banner = active.first().map_or_else(
        || r##"<text x="104" y="606" fill="#5c6e91" font-family="Inter, sans-serif" font-size="20">Активных инцидентов нет</text>"##.to_owned(),
        |inc| {
            let color = inc.severity().unwrap_or(Severity::Degraded).color();
            let extra = if active.len() > 1 { format!(" (+{})", active.len() - 1) } else { String::new() };
            format!(
                r##"<rect x="104" y="576" width="1072" height="46" rx="12" fill="#131f3d" stroke="{color}" stroke-width="1.5"/>
        <circle cx="128" cy="599" r="7" fill="{color}"/>
        <text x="148" y="606" fill="#e8eefb" font-family="Inter, sans-serif" font-size="20">{} · {}{extra}</text>"##,
                xml_escape(&clip_text(&inc.title, 64)),
                xml_escape(&incident_range(inc))
            )
        },
    );
    svg_doc(
        ctx,
        &format!(
            r##"
    {icon}
    <text x="640" y="246" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="50" font-weight="800" letter-spacing="-0.5">{headline}</text>
    <text x="640" y="290" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">Аптайм {uptime} за 90 дней · обновлено {date}</text>

    <rect x="64" y="340" width="1152" height="300" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>
    <text x="104" y="404" fill="#ffffff" font-family="Inter, sans-serif" font-size="30" font-weight="700">{brand}</text>
    <rect x="{px}" y="378" width="{pw}" height="44" rx="12" fill="{pill_color}"/>
    <circle cx="{pc}" cy="400" r="8" fill="#ffffff" opacity="0.9"/>
    <text x="{pt}" y="408" fill="#ffffff" font-family="Inter, sans-serif" font-size="22" font-weight="700">{pill_label}</text>

    {bars}
    <text x="104" y="540" fill="#6f83a6" font-family="Inter, sans-serif" font-size="18">90 дней назад</text>
    <text x="1176" y="540" text-anchor="end" fill="#6f83a6" font-family="Inter, sans-serif" font-size="18">Сегодня</text>

    {banner}

    <text x="64" y="690" fill="#5c6e91" font-family="Inter, sans-serif" font-size="18">Состояние сервиса · обновляется ежедневно</text>"##,
            icon = status_icon(severity, 640.0, 150.0, 36.0),
            headline = xml_escape(summary.label),
            uptime = xml_escape(&format_uptime(summary.uptime_pct)),
            date = xml_escape(&format_date(Some(&local_date_string(ctx.now, ctx.tz)))),
            brand = xml_escape(brand),
            px = num(pill_x),
            pw = num(pill_w),
            pc = num(pill_x + 24.0),
            pt = num(pill_x + 42.0),
            pill_label = xml_escape(pill_label),
            bars = bars(summary, 448.0, 58.0),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::epg::tests::user;
    use crate::news::notices::NoticeKind;
    use crate::render::status::{status_summary, with_provider_notices};

    fn tz() -> TimeZone {
        TimeZone::get("Europe/Tallinn").unwrap()
    }

    fn ctx(tz: &TimeZone) -> RenderCtx<'_> {
        RenderCtx { width: 1280, height: 720, now: "2026-09-14T12:00:00Z".parse().unwrap(), tz, expiring_threshold_days: 7 }
    }

    fn plans() -> Vec<PlanCard> {
        [("standard", "Standard", 499, "Estonian channels"), ("sport", "Sport", 699, "Sport channels"), ("premium", "Premium", 999, "Movie channels"), ("max", "Max", 1299, "All channel groups")]
            .iter()
            .map(|(id, name, price, f)| PlanCard {
                id: (*id).into(),
                name: (*name).into(),
                price_cents: *price,
                currency: "EUR".into(),
                billing_period: String::new(),
                features: vec![(*f).into()],
            })
            .collect()
    }

    const B: Branding<'static> = Branding { brand: "IPTV Test", tagline: "t" };

    #[test]
    fn expired_body_shows_every_plan() {
        let tz = tz();
        let u = user("t", "Expired customer", Some("2020-01-01"), true, false);
        let svg = build_body_svg(&ctx(&tz), &u, &plans(), B);
        assert!(svg.contains("ПОДПИСКА ИСТЕКЛА"));
        for p in plans() {
            assert!(svg.contains(&format!(">{}<", p.name)));
            assert!(svg.contains(&format!(">{}<", p.features[0])));
        }
    }

    #[test]
    fn active_body_is_details_card_with_device_cell() {
        let tz = tz();
        let mut u = user("t", "ivan", Some("2099-01-01"), true, true);
        let svg = build_body_svg(&ctx(&tz), &u, &plans(), B);
        assert!(svg.contains(">АККАУНТ<") && !svg.contains("ПОДПИСКА ИСТЕКЛА"));
        assert!(!svg.contains("УСТРОЙСТВА"));
        u.device_limit = 2;
        let svg = build_card_svg(&ctx(&tz), &u, B, &[]);
        assert!(crate::regex!(r">до 2<tspan[^>]*>одновременно<").is_match(&svg));
    }

    #[test]
    fn feature_text_escaped() {
        let tz = tz();
        let mut p = plans();
        p.truncate(1);
        p[0].features = vec!["Sports & <Movies>".into()];
        let u = user("t", "x", Some("2020-01-01"), true, false);
        let svg = build_expired_plans_svg(&ctx(&tz), &u, &p, "B", PlansVariant::Expired);
        assert!(svg.contains("Sports &amp; &lt;Movies&gt;"));
    }

    fn notice() -> ProviderNotice {
        ProviderNotice {
            id: "1".into(),
            published_at: "2026-09-14T10:06:44.000Z".into(),
            kind: NoticeKind::Maintenance,
            headline: "Технические работы".into(),
            body: "Часть телеканалов <архив> & DVR будет временно недоступна в течение нескольких часов в связи с плановой заменой архивных серверов. Обратите внимание: архивы на затрагиваемых каналах будут формироваться заново с момента завершения работ, это займёт время.".into(),
            ..ProviderNotice::default()
        }
    }

    #[test]
    fn status_slide_mixes_provider_notices() {
        let tz = tz();
        let c = ctx(&tz);
        let summary = status_summary(&[], c.now, &tz, 90);
        let plain = build_status_slide_svg(&c, &summary, "IPTV Test");
        assert_eq!(build_status_slide_svg(&c, &with_provider_notices(summary.clone(), &[], &tz), "IPTV Test"), plain);
        let other = ProviderNotice { id: "2".into(), published_at: "2026-09-14T08:00:00.000Z".into(), kind: NoticeKind::Outage, headline: "Перебои".into(), body: "x".into(), ..ProviderNotice::default() };
        let svg = build_status_slide_svg(&c, &with_provider_notices(summary, &[notice(), other], &tz), "IPTV Test");
        assert!(svg.contains(">Технические работы у провайдера<"));
        assert!(!svg.contains(">Все сервисы работают<"));
        assert!(svg.contains(">Провайдер<"));
        assert!(svg.contains("#2563eb"));
        assert!(svg.contains(">Провайдер · 14 сен 2026 · 13:06<"));
        assert!(svg.contains("&lt;архив&gt; &amp; DVR"));
        assert!(svg.contains(">Перебои<"));
    }

    #[test]
    fn own_incident_keeps_headline() {
        let tz = tz();
        let c = ctx(&tz);
        let inc = |t: &str, s: &str, d: &str, n: &str| Incident {
            title: t.into(),
            severity: s.into(),
            starts_on: Some(d.into()),
            note: n.into(),
            ..Incident::default()
        };
        let incidents = [inc("Сбой <EPG>", "outage", "2026-09-14", "Чиним"), inc("Медленно", "degraded", "2026-09-13", "Смотрим"), inc("Ещё", "degraded", "2026-09-12", "Тоже")];
        let svg = build_status_slide_svg(&c, &with_provider_notices(status_summary(&incidents, c.now, &tz, 90), &[notice()], &tz), "IPTV Test");
        assert!(svg.contains(">Сбой в работе сервиса<"));
        assert!(svg.contains("Сбой &lt;EPG&gt;"));
        assert!(svg.contains(">Технические работы<"));
        assert!(!svg.contains(">Медленно<"));
        assert!(svg.contains("Ещё событий: 2"));
    }

    #[test]
    fn wrap_and_slot_text() {
        assert_eq!(wrap_text("aaa bbb ccc", 7, 3), ["aaa bbb", "ccc"]);
        let lines = wrap_text("one two three four five six", 9, 2);
        assert_eq!(lines[0], "one two");
        assert!(lines[1].ends_with('…') && lines[1].chars().count() <= 9);
        let tz = tz();
        let svg = build_device_limit_svg(&ctx(&tz), "A & B", 60);
        assert!(svg.contains("Превышен лимит устройств") && svg.contains("A &amp; B") && svg.contains("через минуту"));
        assert_eq!(slot_free_text(120), "через 2 мин.");
        assert_eq!(slot_free_text(45), "через 45 сек.");
    }

    #[test]
    fn frames_rasterize() {
        let tz = tz();
        let raster = crate::render::raster::Rasterizer::new(std::path::Path::new("/nonexistent"));
        let svg = build_brand_slide1_svg(&ctx(&tz), B, Some("https://x.example/sub/abc"));
        let png = raster.svg_to_png(&svg, 320, 180).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }
}

#[cfg(test)]
mod preview {
    //! `OVERLAY_PREVIEW_DIR=/tmp/x cargo test dump_previews -- --ignored`
    //! writes every frame as PNG for eyeballing.
    use super::*;
    use crate::epg::epg::tests::user;
    use crate::render::status::status_summary;

    #[test]
    #[ignore = "writes PNG files for manual inspection"]
    fn dump_previews() {
        let Ok(dir) = std::env::var("OVERLAY_PREVIEW_DIR") else { return };
        let dir = std::path::PathBuf::from(dir);
        let tz = TimeZone::get("Europe/Tallinn").unwrap();
        let ctx = RenderCtx { width: 1280, height: 720, now: Timestamp::now(), tz: &tz, expiring_threshold_days: 7 };
        let b = Branding { brand: "Мой IPTV-сервис", tagline: "Информационный канал аккаунта" };
        let raster = crate::render::raster::Rasterizer::new(std::path::Path::new("/usr/share/fonts"));
        let plans = vec![PlanCard { id: "basic".into(), name: "Базовый".into(), price_cents: 499, currency: "EUR".into(), billing_period: "month".into(), features: vec!["Спорт".into(), "Кино".into()] }];
        let mut active = user("t", "Иван Петров", Some("2099-01-01"), true, true);
        active.device_limit = 2;
        let frames = [
            ("intro", build_brand_slide1_svg(&ctx, b, Some("https://iptv.example/sub/abc"))),
            ("card", build_body_svg(&ctx, &active, &plans, b)),
            ("expired", build_body_svg(&ctx, &user("t", "Иван", Some("2020-01-01"), true, true), &plans, b)),
            ("status", build_status_slide_svg(&ctx, &status_summary(&[], ctx.now, &tz, 90), b.brand)),
            ("devices", build_device_limit_svg(&ctx, b.brand, 60)),
        ];
        for (name, svg) in frames {
            raster.render_to_file(&svg, 1280, 720, &dir.join(format!("{name}.png"))).unwrap();
        }
    }
}
