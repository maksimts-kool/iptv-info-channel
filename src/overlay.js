// Builds the per-user channel visuals as SVG and rasterizes them to PNG with sharp.
// Two frames make up a channel: the brand intro and the account-specific body.
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import {
  formatPrice, periodLabel, formatDate, daysLeft, accountStatus, STATUS_META, pluralDays,
  localDateString, xmlEscape,
} from './util.js';
import { SEVERITY, formatUptime } from './status.js';

// Shared <defs> + background used by every frame so the intro and card feel
// like one continuous channel.
const SHARED_DEFS = `
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
  </defs>`;

const BG = `
  <rect width="1280" height="720" fill="url(#bg)"/>
  <g opacity="0.05" stroke="#ffffff" stroke-width="1">
    ${Array.from({ length: 12 }, (_, i) => `<line x1="${i * 110}" y1="0" x2="${i * 110}" y2="720"/>`).join('')}
  </g>
  <rect x="0" y="0" width="1280" height="8" fill="url(#accent)"/>`;

function svgDoc(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${config.channel.width}" height="${config.channel.height}" viewBox="0 0 1280 720">${SHARED_DEFS}${BG}${inner}</svg>`;
}

// A small rounded "logo mark" with the brand's initial — purely decorative.
function logoMark(brand, cx, cy, size) {
  const initial = xmlEscape((brand || 'I').trim().charAt(0).toUpperCase() || 'I');
  const half = size / 2;
  return `
    <rect x="${cx - half}" y="${cy - half}" width="${size}" height="${size}" rx="${size * 0.26}" fill="url(#accent)" filter="url(#soft)"/>
    <text x="${cx}" y="${cy + size * 0.18}" text-anchor="middle" fill="#0b1224" font-family="Inter, sans-serif" font-size="${size * 0.55}" font-weight="800">${initial}</text>`;
}

// ---- Intro slide 1: the brand reveal ----
export function buildBrandSlide1Svg(settings = {}) {
  const brand = xmlEscape(settings.brand_name || 'Мой IPTV-сервис');
  return svgDoc(`
    <rect width="1280" height="720" fill="url(#glow)"/>
    ${logoMark(settings.brand_name, 640, 300, 150)}
    <text x="640" y="470" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="72" font-weight="800" letter-spacing="-1">${brand}</text>
    <rect x="560" y="500" width="160" height="6" rx="3" fill="url(#accent)"/>`);
}

// ---- The looping info card (user details) ----
export function buildCardSvg(user, settings = {}, plans = []) {
  const status = accountStatus(user, config.expiringThresholdDays);
  const meta = STATUS_META[status];
  const d = daysLeft(user.expires_at);
  const daysText =
    d === null ? 'бессрочно'
    : d < 0 ? `${Math.abs(d)} ${pluralDays(d)} назад`
    : `${d} ${pluralDays(d)}`;

  const brand = xmlEscape(settings.brand_name || 'Мой IPTV-сервис');
  const tagline = xmlEscape(settings.tagline || 'Информационный канал аккаунта');
  const price = formatPrice(user.price_cents, user.currency);
  const period = periodLabel(user.billing_period);
  const statusFontSize = meta.label.length > 10 ? 27 : 32;

  // In the final days the card swaps its lower half for a renewal strip that
  // surfaces the available plans (see buildRenewingCardSvg). Healthy accounts
  // keep the original layout untouched.
  if (status === 'expiring') {
    return buildRenewingCardSvg(user, plans, settings, {
      meta, daysLeftValue: d, brand, tagline, price, period, statusFontSize,
    });
  }

  return svgDoc(`
  <!-- Header -->
  <text x="80" y="92" fill="#ffffff" font-family="Inter, sans-serif" font-size="40" font-weight="700" letter-spacing="-0.5">${brand}</text>
  <text x="80" y="130" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">${tagline}</text>

  <!-- Card panel -->
  <rect x="64" y="170" width="1152" height="470" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>

  <!-- Account -->
  <text x="104" y="248" fill="#7f93b5" font-family="Inter, sans-serif" font-size="22" letter-spacing="2">АККАУНТ</text>
  <text x="104" y="312" fill="#ffffff" font-family="Inter, sans-serif" font-size="58" font-weight="700" letter-spacing="-1">${xmlEscape(user.username)}</text>

  <!-- Status banner -->
  <rect x="820" y="214" width="356" height="86" rx="16" fill="${meta.color}"/>
  <circle cx="860" cy="257" r="12" fill="#ffffff" opacity="0.9"/>
  <text x="888" y="267" fill="#ffffff" font-family="Inter, sans-serif" font-size="${statusFontSize}" font-weight="800">${meta.label}</text>

  <!-- Divider -->
  <line x1="104" y1="372" x2="1176" y2="372" stroke="#24345f" stroke-width="1.5"/>

  <!-- Info grid -->
  <g font-family="Inter, sans-serif">
    <text x="104" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ТАРИФ</text>
    <text x="104" y="492" fill="#ffffff" font-size="44" font-weight="700">${xmlEscape(user.plan_name)}</text>

    <text x="464" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ЦЕНА</text>
    <text x="464" y="492" fill="#7dd3fc" font-size="44" font-weight="700">${xmlEscape(price)}${period ? `<tspan font-size="26" font-weight="600">${xmlEscape(period)}</tspan>` : ''}</text>

    <text x="824" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ИСТЕКАЕТ</text>
    <text x="824" y="492" fill="#ffffff" font-size="44" font-weight="700">${xmlEscape(formatDate(user.expires_at))}</text>

    <text x="104" y="566" fill="#7f93b5" font-size="22" letter-spacing="2">ОСТАЛОСЬ ВРЕМЕНИ</text>
    <text x="104" y="612" fill="${meta.color}" font-size="40" font-weight="800">${xmlEscape(daysText)}</text>
  </g>

  <!-- Footer -->
  <text x="64" y="690" fill="#5c6e91" font-family="Inter, sans-serif" font-size="18">Обновлено ${xmlEscape(formatDate(localDateString()))} · Канал обновляется ежедневно</text>`);
}

// A compact plan chip used in the renewal strip: name + price, current plan
// highlighted with the accent stroke and a "ВАШ ТАРИФ" tag.
function compactPlanChip(plan, x, y, w, h, isCurrent) {
  const nameChars = Math.max(8, Math.floor((w - 28) / 13));
  const periodSuffix = periodLabel(plan.billing_period);
  return `
    <g font-family="Inter, sans-serif">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#131f3d" stroke="${isCurrent ? '#38bdf8' : '#2b3d68'}" stroke-width="${isCurrent ? 2.5 : 1.5}"/>
      <text x="${x + 18}" y="${y + 30}" fill="#ffffff" font-size="21" font-weight="700">${xmlEscape(clipText(plan.name, nameChars))}</text>
      <text x="${x + 18}" y="${y + 60}" fill="#7dd3fc" font-size="27" font-weight="800">${xmlEscape(formatPrice(plan.price_cents, plan.currency))}${periodSuffix ? `<tspan font-size="17" font-weight="600">${xmlEscape(periodSuffix)}</tspan>` : ''}</text>
      ${isCurrent ? `<text x="${x + w - 16}" y="${y + 26}" text-anchor="end" fill="#38bdf8" font-size="14" font-weight="700" letter-spacing="1">ВАШ ТАРИФ</text>` : ''}
    </g>`;
}

// Card variant for accounts in their final days: a condensed info row plus a
// "продлите подписку" strip of plan chips. The day-counter turns urgent and the
// very last day reads "Последний день".
function buildRenewingCardSvg(user, plans, settings, ctx) {
  const { meta, daysLeftValue: d, brand, tagline } = ctx;
  const urgentDays = d === 0 ? 'Последний день' : `${d} ${pluralDays(d)}`;

  const visiblePlans = (plans || []).slice(0, 4);
  const gridX = 104;
  const gridRight = 1176;
  const gridWidth = gridRight - gridX;
  const chipHeight = 74;
  const chipY = 548;
  const chipGap = 16;
  const n = visiblePlans.length;
  const chipWidth = n ? (gridWidth - chipGap * (n - 1)) / n : gridWidth;
  const chips = visiblePlans
    .map((plan, i) => compactPlanChip(
      plan,
      gridX + i * (chipWidth + chipGap),
      chipY,
      chipWidth,
      chipHeight,
      plan.id === user.plan_id,
    ))
    .join('');
  const chipsOrFallback = n
    ? chips
    : `<text x="${gridX}" y="${chipY + 44}" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">Свяжитесь с администратором для продления подписки</text>`;

  return svgDoc(`
  <!-- Header -->
  <text x="80" y="92" fill="#ffffff" font-family="Inter, sans-serif" font-size="40" font-weight="700" letter-spacing="-0.5">${brand}</text>
  <text x="80" y="130" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">${tagline}</text>

  <!-- Card panel -->
  <rect x="64" y="170" width="1152" height="470" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>

  <!-- Account -->
  <text x="104" y="232" fill="#7f93b5" font-family="Inter, sans-serif" font-size="22" letter-spacing="2">АККАУНТ</text>
  <text x="104" y="294" fill="#ffffff" font-family="Inter, sans-serif" font-size="54" font-weight="700" letter-spacing="-1">${xmlEscape(clipText(user.username, 22))}</text>

  <!-- Status banner -->
  <rect x="820" y="200" width="356" height="86" rx="16" fill="${meta.color}"/>
  <circle cx="860" cy="243" r="12" fill="#ffffff" opacity="0.9"/>
  <text x="888" y="253" fill="#ffffff" font-family="Inter, sans-serif" font-size="${ctx.statusFontSize}" font-weight="800">${meta.label}</text>

  <!-- Divider -->
  <line x1="104" y1="338" x2="1176" y2="338" stroke="#24345f" stroke-width="1.5"/>

  <!-- Condensed info row -->
  <g font-family="Inter, sans-serif">
    <text x="104" y="386" fill="#7f93b5" font-size="20" letter-spacing="2">ТАРИФ</text>
    <text x="104" y="434" fill="#ffffff" font-size="38" font-weight="700">${xmlEscape(clipText(user.plan_name, 16))}</text>

    <text x="520" y="386" fill="#7f93b5" font-size="20" letter-spacing="2">ИСТЕКАЕТ</text>
    <text x="520" y="434" fill="#ffffff" font-size="38" font-weight="700">${xmlEscape(formatDate(user.expires_at))}</text>

    <text x="880" y="386" fill="#7f93b5" font-size="20" letter-spacing="2">ОСТАЛОСЬ</text>
    <text x="880" y="434" fill="${meta.color}" font-size="38" font-weight="800">${xmlEscape(urgentDays)}</text>
  </g>

  <!-- Renewal strip -->
  <text x="104" y="510" fill="#38bdf8" font-family="Inter, sans-serif" font-size="24" font-weight="800" letter-spacing="1">ПРОДЛИТЕ ПОДПИСКУ</text>
  ${chipsOrFallback}

  <!-- Footer -->
  <text x="64" y="690" fill="#5c6e91" font-family="Inter, sans-serif" font-size="18">Обновлено ${xmlEscape(formatDate(localDateString()))} · Свяжитесь с администратором, чтобы продлить</text>`);
}

function clipText(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
}

function planGridLayout(count) {
  if (count <= 4) return { columns: Math.max(1, count), rows: 1 };
  if (count <= 6) return { columns: 3, rows: 2 };
  return { columns: 4, rows: Math.ceil(count / 4) };
}

// Header variants for the full plans grid: the red "expired" framing and the
// orange "last valid day" framing (account still works today, so we nudge
// rather than declare it dead).
const PLANS_HEADER = {
  expired: {
    badge: 'ПОДПИСКА ИСТЕКЛА',
    badgeColor: '#dc2626',
    heading: (name) => `${name}, выберите новый тариф`,
    sub: 'Доступные планы для продления подписки',
  },
  lastDay: {
    badge: 'ПОСЛЕДНИЙ ДЕНЬ',
    badgeColor: '#d97706',
    heading: (name) => `${name}, продлите подписку`,
    sub: 'Подписка истекает сегодня — выберите тариф, чтобы не потерять доступ',
  },
};

// Expired accounts (and, with variant: 'lastDay', accounts on their final valid
// day) see the currently available plans instead of the regular details card.
// The common 2/3/4-plan cases are a single centered row.
export function buildExpiredPlansSvg(user, plans = [], settings = {}, { variant = 'expired' } = {}) {
  const head = PLANS_HEADER[variant] || PLANS_HEADER.expired;
  const brand = xmlEscape(settings.brand_name || 'Мой IPTV-сервис');
  const visiblePlans = plans.slice(0, 12);
  const { columns, rows } = planGridLayout(visiblePlans.length);
  const gap = rows === 1 ? 18 : 14;
  const gridX = 64;
  const gridY = 218;
  const gridWidth = 1152;
  const gridHeight = 400;
  const cardWidth = (gridWidth - gap * (columns - 1)) / columns;
  const cardHeight = (gridHeight - gap * (rows - 1)) / rows;
  const compact = cardHeight < 250;
  const featureFontSize = compact ? 16 : columns >= 4 ? 18 : 21;
  const featureLineHeight = compact ? 27 : 38;
  const featureStart = compact ? 112 : 184;
  const maxFeatureRows = Math.max(0, Math.floor((cardHeight - featureStart - 18) / featureLineHeight) + 1);
  const maxFeatureChars = Math.max(14, Math.floor((cardWidth - 58) / (featureFontSize * 0.56)));

  const cards = visiblePlans.map((plan, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = gridX + column * (cardWidth + gap);
    const y = gridY + row * (cardHeight + gap);
    const current = plan.id === user.plan_id;
    const nameSize = compact ? 24 : columns >= 4 ? 26 : 31;
    const priceSize = compact ? 27 : columns >= 4 ? 33 : 39;
    const nameChars = Math.max(8, Math.floor((cardWidth - 40) / (nameSize * 0.58)));
    const allFeatures = plan.features || [];
    const hasOverflow = allFeatures.length > maxFeatureRows && maxFeatureRows > 0;
    const shownFeatureCount = hasOverflow ? maxFeatureRows - 1 : maxFeatureRows;
    const features = allFeatures.slice(0, shownFeatureCount);
    const hiddenFeatureCount = Math.max(0, allFeatures.length - features.length);

    const featureRows = features.map((feature, featureIndex) => {
      const fy = y + featureStart + featureIndex * featureLineHeight;
      return `
        <circle cx="${x + 27}" cy="${fy - 6}" r="${compact ? 4 : 5}" fill="#38bdf8"/>
        <text x="${x + 42}" y="${fy}" fill="#c7d5eb" font-size="${featureFontSize}">${xmlEscape(clipText(feature, maxFeatureChars))}</text>`;
    }).join('');

    const moreRow = hiddenFeatureCount && maxFeatureRows
      ? `<text x="${x + 24}" y="${y + featureStart + features.length * featureLineHeight}" fill="#7f93b5" font-size="${featureFontSize}">+${hiddenFeatureCount} ещё</text>`
      : '';

    return `
      <g font-family="Inter, sans-serif">
        <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="${compact ? 14 : 20}" fill="#131f3d" stroke="${current ? '#38bdf8' : '#2b3d68'}" stroke-width="${current ? 3 : 1.5}"/>
        <text x="${x + 24}" y="${y + (compact ? 43 : 58)}" fill="#ffffff" font-size="${nameSize}" font-weight="700">${xmlEscape(clipText(plan.name, nameChars))}</text>
        <text x="${x + 24}" y="${y + (compact ? 82 : 119)}" fill="#7dd3fc" font-size="${priceSize}" font-weight="800">${xmlEscape(formatPrice(plan.price_cents, plan.currency))}${periodLabel(plan.billing_period) ? `<tspan font-size="${Math.round(priceSize * 0.62)}" font-weight="600">${xmlEscape(periodLabel(plan.billing_period))}</tspan>` : ''}</text>
        ${compact ? '' : `<line x1="${x + 24}" y1="${y + 146}" x2="${x + cardWidth - 24}" y2="${y + 146}" stroke="#2b3d68" stroke-width="1"/>`}
        ${featureRows || (compact ? '' : `<text x="${x + 24}" y="${y + featureStart}" fill="#7f93b5" font-size="${featureFontSize}">Подробности у администратора</text>`)}
        ${moreRow}
      </g>`;
  }).join('');

  const emptyState = visiblePlans.length ? '' : `
    <rect x="360" y="280" width="560" height="210" rx="22" fill="#131f3d" stroke="#2b3d68" stroke-width="1.5"/>
    <text x="640" y="365" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="34" font-weight="700">Тарифы скоро появятся</text>
    <text x="640" y="415" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">Свяжитесь с администратором для продления</text>`;

  const extraCount = Math.max(0, plans.length - visiblePlans.length);
  const badgeWidth = 40 + head.badge.length * 15;
  const badgeX = 1216 - badgeWidth;
  return svgDoc(`
    <text x="64" y="76" fill="#ffffff" font-family="Inter, sans-serif" font-size="34" font-weight="700" letter-spacing="-0.5">${brand}</text>
    <rect x="${badgeX}" y="42" width="${badgeWidth}" height="55" rx="14" fill="${head.badgeColor}"/>
    <text x="${badgeX + badgeWidth / 2}" y="79" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="24" font-weight="800">${head.badge}</text>
    <text x="64" y="146" fill="#ffffff" font-family="Inter, sans-serif" font-size="42" font-weight="800" letter-spacing="-0.8">${xmlEscape(head.heading(clipText(user.username, 34)))}</text>
    <text x="64" y="184" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">${xmlEscape(head.sub)}</text>
    ${cards}
    ${emptyState}
    <text x="64" y="684" fill="#6f83a6" font-family="Inter, sans-serif" font-size="18">Свяжитесь с администратором, чтобы активировать выбранный тариф${extraCount ? ` · Ещё тарифов: ${extraCount}` : ''}</text>`);
}

// ---- Status board slide (Better Stack–style service status) ----

// A green check (operational) or white exclamation (incident) inside a state-
// coloured disc.
function statusIcon(state, cx, cy, r) {
  const color = SEVERITY[state].color;
  if (state === 'operational') {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>
      <path d="M${cx - 16} ${cy} L${cx - 5} ${cy + 12} L${cx + 17} ${cy - 13}" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>
    <rect x="${cx - 3}" y="${cy - 17}" width="6" height="22" rx="3" fill="#ffffff"/>
    <circle cx="${cx}" cy="${cy + 14}" r="4" fill="#ffffff"/>`;
}

function incidentRange(inc) {
  const start = formatDate(inc.starts_on);
  if (!inc.ends_on) return `с ${start}`;
  if (inc.ends_on === inc.starts_on) return start;
  return `${start} — ${formatDate(inc.ends_on)}`;
}

// Builds the status slide from a statusSummary() result (see status.js).
export function buildStatusSlideSvg(summary, settings = {}) {
  const brand = xmlEscape(settings.brand_name || 'Мой IPTV-сервис');
  const headline = xmlEscape(summary.label);
  const dateStr = xmlEscape(formatDate(localDateString()));
  const uptime = xmlEscape(formatUptime(summary.uptimePct));
  const pill = SEVERITY[summary.state];
  const pillW = 64 + pill.label.length * 15;
  const pillX = 1176 - pillW;

  const x0 = 104;
  const stripWidth = 1072;
  const n = summary.days.length || 1;
  const gap = 2;
  const barWidth = (stripWidth - gap * (n - 1)) / n;
  const barY = 448;
  const barHeight = 58;
  const bars = summary.days.map((day, i) => {
    const x = x0 + i * (barWidth + gap);
    return `<rect x="${x.toFixed(2)}" y="${barY}" width="${barWidth.toFixed(2)}" height="${barHeight}" rx="2" fill="${day.color}"/>`;
  }).join('');

  const active = summary.activeIncidents || [];
  const banner = active.length
    ? (() => {
      const inc = [...active].sort((a, b) => SEVERITY[b.severity].rank - SEVERITY[a.severity].rank)[0];
      const extra = active.length > 1 ? ` (+${active.length - 1})` : '';
      return `<rect x="104" y="576" width="1072" height="46" rx="12" fill="#131f3d" stroke="${SEVERITY[inc.severity].color}" stroke-width="1.5"/>
        <circle cx="128" cy="599" r="7" fill="${SEVERITY[inc.severity].color}"/>
        <text x="148" y="606" fill="#e8eefb" font-family="Inter, sans-serif" font-size="20">${xmlEscape(clipText(inc.title, 64))} · ${xmlEscape(incidentRange(inc))}${extra}</text>`;
    })()
    : '<text x="104" y="606" fill="#5c6e91" font-family="Inter, sans-serif" font-size="20">Активных инцидентов нет</text>';

  return svgDoc(`
    ${statusIcon(summary.state, 640, 150, 36)}
    <text x="640" y="246" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="50" font-weight="800" letter-spacing="-0.5">${headline}</text>
    <text x="640" y="290" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">Аптайм ${uptime} за 90 дней · обновлено ${dateStr}</text>

    <rect x="64" y="340" width="1152" height="300" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>
    <text x="104" y="404" fill="#ffffff" font-family="Inter, sans-serif" font-size="30" font-weight="700">${brand}</text>
    <rect x="${pillX}" y="378" width="${pillW}" height="44" rx="12" fill="${pill.color}"/>
    <circle cx="${pillX + 24}" cy="400" r="8" fill="#ffffff" opacity="0.9"/>
    <text x="${pillX + 42}" y="408" fill="#ffffff" font-family="Inter, sans-serif" font-size="22" font-weight="700">${xmlEscape(pill.label)}</text>

    ${bars}
    <text x="104" y="540" fill="#6f83a6" font-family="Inter, sans-serif" font-size="18">90 дней назад</text>
    <text x="1176" y="540" text-anchor="end" fill="#6f83a6" font-family="Inter, sans-serif" font-size="18">Сегодня</text>

    ${banner}

    <text x="64" y="690" fill="#5c6e91" font-family="Inter, sans-serif" font-size="18">Состояние сервиса · обновляется ежедневно</text>`);
}

// ---- World Cup 2026 match-list slide ----
//
// A chronological list of fixtures around "today" (see buildWorldCupModel in
// worldcup.js): a couple of recent results, anything live, then the next games.
// Each row is one match on a single line — date/time, stage tag, both teams and
// the score/result — styled like the account card. Once the Final is decided the
// slide switches to a champion summary instead.

const WC_LIST_TOP = 132;
const WC_LIST_BOTTOM = 686;
const WC_ROW_MAX_H = 92;
const WC_SCORE_CX = 800; // horizontal centre of the score column

// Shorten the long FIFA seeding placeholders so they fit a row. Real country
// names (and anything not matching) pass through untouched.
function shortSeed(label) {
  return String(label ?? '')
    .replace(/^Победитель группы (\S+)$/, 'Победитель гр. $1')
    .replace(/^Второе место в группе (\S+)$/, '2-е место, гр. $1')
    .replace(/^3-е место в группе (\S+)$/, '3-е место: $1')
    .replace(/^Проигравший в полуфинале$/, 'Проигравший в 1/2');
}

// Right-edge of the status pill (inside the row's right padding).
const WC_BADGE_RIGHT = 1192;

// Stroked, colour-coded status pill per match state. The border + tinted fill
// make the status pop far more than the old grey caption did.
const WC_STATUS_BADGE = {
  live: { label: 'В ЭФИРЕ', stroke: '#dc2626', text: '#fca5a5', dot: true },
  finished: { label: 'ЗАВЕРШЁН', stroke: '#16a34a', text: '#86efac' },
  postponed: { label: 'ПЕРЕНЕСЁН', stroke: '#d97706', text: '#fcd34d' },
  scheduled: { label: 'СКОРО', stroke: '#38bdf8', text: '#7dd3fc' },
};

function wcStatusBadge(statusKey, cy) {
  const b = WC_STATUS_BADGE[statusKey] || WC_STATUS_BADGE.scheduled;
  const text = `${b.dot ? '● ' : ''}${b.label}`;
  const pillW = Math.round(text.length * 8.6 + 32);
  const x = WC_BADGE_RIGHT - pillW;
  return `
    <rect x="${x}" y="${cy - 15}" width="${pillW}" height="30" rx="15" fill="${b.stroke}" fill-opacity="0.14" stroke="${b.stroke}" stroke-width="1.6"/>
    <text x="${x + pillW / 2}" y="${cy + 5}" text-anchor="middle" fill="${b.text}" font-size="13" font-weight="800" letter-spacing="0.8">${text}</text>`;
}

// One fixture row. `top` is its top edge; `h` its allotted height.
function wcFixtureRow(fixture, top, h) {
  const cy = top + h / 2;
  const live = fixture.status.key === 'live';
  const finished = fixture.status.key === 'finished';
  const x = 64;
  const w = 1152;
  const fill = live ? '#16203f' : '#0f1830';
  const stroke = live ? '#dc2626' : '#1c2a4d';

  const hasScore = fixture.home.score !== null && fixture.home.score !== undefined
    && fixture.away.score !== null && fixture.away.score !== undefined;
  const scoreColor = live ? '#fca5a5' : '#ffffff';
  const scoreText = hasScore
    ? `${fixture.home.score} – ${fixture.away.score}`
    : '—';

  // Left column: date, plus the kickoff time for matches that haven't started.
  const showTime = !finished && fixture.time;
  const dateY = showTime ? cy - 5 : cy + 5;
  const timeLine = showTime
    ? `<text x="92" y="${cy + 16}" fill="#7dd3fc" font-size="14" font-weight="700">${xmlEscape(fixture.time)}</text>`
    : '';

  const teamName = (team, anchor, tx) => {
    const color = team.winner ? '#ffffff' : finished ? '#9fb3d1' : '#dbe5f5';
    const weight = team.winner ? 800 : 600;
    return `<text x="${tx}" y="${cy + 6}" text-anchor="${anchor}" fill="${color}" font-size="20" font-weight="${weight}">${xmlEscape(clipText(shortSeed(team.label), 16))}</text>`;
  };

  return `
    ${live ? `<rect x="${x}" y="${top + 6}" width="5" height="${h - 12}" rx="2.5" fill="#dc2626"/>` : ''}
    <rect x="${x}" y="${top + 6}" width="${w}" height="${h - 12}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="${live ? 2.5 : 1.5}"/>
    <g font-family="Inter, sans-serif">
      <text x="92" y="${dateY}" fill="#dbe5f5" font-size="16" font-weight="700">${xmlEscape(fixture.dateLabel)}</text>
      ${timeLine}
      <text x="250" y="${cy + 5}" fill="#7f93b5" font-size="15" font-weight="700">${xmlEscape(clipText(fixture.stageLabel, 18))}</text>
      ${teamName(fixture.home, 'end', WC_SCORE_CX - 38)}
      <text x="${WC_SCORE_CX}" y="${cy + 7}" text-anchor="middle" fill="${scoreColor}" font-size="22" font-weight="800">${xmlEscape(scoreText)}</text>
      ${teamName(fixture.away, 'start', WC_SCORE_CX + 38)}
      ${wcStatusBadge(fixture.status.key, cy)}
    </g>`;
}

function wcFixtureList(fixtures) {
  const areaH = WC_LIST_BOTTOM - WC_LIST_TOP;
  const rowH = Math.min(WC_ROW_MAX_H, areaH / fixtures.length);
  const startY = WC_LIST_TOP + (areaH - rowH * fixtures.length) / 2;
  return fixtures.map((fx, i) => wcFixtureRow(fx, startY + i * rowH, rowH)).join('');
}

// Champion summary shown once the Final has a winner.
function wcChampion(champion) {
  const hasScore = champion.champScore !== null && champion.champScore !== undefined
    && champion.runnerScore !== null && champion.runnerScore !== undefined;
  const finalLine = hasScore
    ? `Финал: ${champion.team} ${champion.champScore} – ${champion.runnerScore} ${champion.runnerUp}`
    : `Финал: ${champion.team} — ${champion.runnerUp}`;
  return `
    <text x="640" y="250" text-anchor="middle" fill="#7dd3fc" font-family="Inter, sans-serif" font-size="30" font-weight="800" letter-spacing="3">ЧЕМПИОН МИРА 2026</text>
    <text x="640" y="372" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="88" font-weight="800">${xmlEscape(clipText(champion.team, 22))}</text>
    <text x="640" y="446" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="26" font-weight="600">${xmlEscape(clipText(finalLine, 60))}</text>`;
}

// Centred message shown before the knockout stage begins.
function wcNotStarted(notStarted) {
  return `
    <text x="640" y="300" text-anchor="middle" fill="#7dd3fc" font-family="Inter, sans-serif" font-size="30" font-weight="800" letter-spacing="3">СТАРТ ПЛЕЙ-ОФФ</text>
    <text x="640" y="406" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="84" font-weight="800">${xmlEscape(notStarted.startLabel)}</text>
    <text x="640" y="462" text-anchor="middle" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="26" font-weight="600">Первые матчи — 1/16 финала</text>`;
}

// Builds the match-list slide from a buildWorldCupModel() result (see worldcup.js).
export function buildWorldCupSlideSvg(model, settings = {}) {
  const brand = xmlEscape(settings.brand_name || 'Мой IPTV-сервис');
  const headline = xmlEscape(model.headline || 'Плей-офф');
  const updated = xmlEscape(model.updated || '');
  const headerTop = `
    <text x="64" y="56" fill="#ffffff" font-family="Inter, sans-serif" font-size="38" font-weight="800" letter-spacing="-0.5">Чемпионат мира 2026</text>
    <text x="1216" y="50" text-anchor="end" fill="#ffffff" font-family="Inter, sans-serif" font-size="26" font-weight="700">${brand}</text>
    <text x="1216" y="82" text-anchor="end" fill="#6f83a6" font-family="Inter, sans-serif" font-size="18">Обновлено ${updated}</text>`;

  // The champion / not-started views are full-slide centred messages, so they
  // skip the headline subtitle that the fixture list shows.
  if (model.champion) return svgDoc(`${headerTop}${wcChampion(model.champion)}`);
  if (model.notStarted) return svgDoc(`${headerTop}${wcNotStarted(model.notStarted)}`);

  const fixtures = model.fixtures || [];
  const body = fixtures.length
    ? wcFixtureList(fixtures)
    : '<text x="640" y="400" text-anchor="middle" fill="#7f93b5" font-family="Inter, sans-serif" font-size="26" font-weight="700">Матчей пока нет</text>';

  return svgDoc(`${headerTop}
    <text x="64" y="90" fill="#7dd3fc" font-family="Inter, sans-serif" font-size="24" font-weight="700">${headline}</text>
    ${body}
    <text x="64" y="704" fill="#5c6e91" font-family="Inter, sans-serif" font-size="16">Расписание матчей · обновляется ежедневно</text>`);
}

async function svgToPng(svg, outPath) {
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

export async function renderStatusPng(summary, settings, outPath) {
  return svgToPng(buildStatusSlideSvg(summary, settings), outPath);
}

export async function renderWorldCupPng(model, settings, outPath) {
  return svgToPng(buildWorldCupSlideSvg(model, settings), outPath);
}

export function buildBodySvg(user, plans = [], settings = {}) {
  const status = accountStatus(user, config.expiringThresholdDays);
  if (status === 'expired') return buildExpiredPlansSvg(user, plans, settings);
  // On the final valid day, surface the full plans grid (with renew framing)
  // instead of the compact renewal strip embedded in the details card.
  if (status === 'expiring' && daysLeft(user.expires_at) === 0) {
    return buildExpiredPlansSvg(user, plans, settings, { variant: 'lastDay' });
  }
  return buildCardSvg(user, settings, plans);
}

export async function renderBodyPng(user, settings, outPath, plans = []) {
  return svgToPng(buildBodySvg(user, plans, settings), outPath);
}

// Render the loop frames into dir. Returns { slide1, card, status?, worldcup? }
// paths; the global slides are rendered only when their model is supplied.
export async function renderSlidesPng(
  user, settings, dir, plans = [], summary = null, worldcup = null,
) {
  const out = {
    slide1: path.join(dir, 'slide1.png'),
    card: path.join(dir, 'card.png'),
  };
  const jobs = [
    svgToPng(buildBrandSlide1Svg(settings), out.slide1),
    renderBodyPng(user, settings, out.card, plans),
  ];
  if (summary) {
    out.status = path.join(dir, 'status.png');
    jobs.push(renderStatusPng(summary, settings, out.status));
  }
  if (worldcup) {
    out.worldcup = path.join(dir, 'worldcup.png');
    jobs.push(renderWorldCupPng(worldcup, settings, out.worldcup));
  }
  await Promise.all(jobs);
  return out;
}
