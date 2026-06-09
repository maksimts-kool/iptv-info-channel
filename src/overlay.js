// Builds the per-user channel visuals as SVG and rasterizes them to PNG with sharp.
// Two frames make up a channel: the brand intro and the account-specific body.
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import {
  formatPrice, formatDate, daysLeft, accountStatus, STATUS_META, pluralDays, localDateString,
} from './util.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  const initial = esc((brand || 'I').trim().charAt(0).toUpperCase() || 'I');
  const half = size / 2;
  return `
    <rect x="${cx - half}" y="${cy - half}" width="${size}" height="${size}" rx="${size * 0.26}" fill="url(#accent)" filter="url(#soft)"/>
    <text x="${cx}" y="${cy + size * 0.18}" text-anchor="middle" fill="#0b1224" font-family="Inter, sans-serif" font-size="${size * 0.55}" font-weight="800">${initial}</text>`;
}

// ---- Intro slide 1: the brand reveal ----
export function buildBrandSlide1Svg(settings = {}) {
  const brand = esc(settings.brand_name || 'Мой IPTV-сервис');
  return svgDoc(`
    <rect width="1280" height="720" fill="url(#glow)"/>
    ${logoMark(settings.brand_name, 640, 300, 150)}
    <text x="640" y="470" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="72" font-weight="800" letter-spacing="-1">${brand}</text>
    <rect x="560" y="500" width="160" height="6" rx="3" fill="url(#accent)"/>`);
}

// ---- The looping info card (user details) ----
export function buildCardSvg(user, settings = {}) {
  const status = accountStatus(user, config.expiringThresholdDays);
  const meta = STATUS_META[status];
  const d = daysLeft(user.expires_at);
  const daysText =
    d === null ? 'бессрочно'
    : d < 0 ? `${Math.abs(d)} ${pluralDays(d)} назад`
    : `${d} ${pluralDays(d)}`;

  const brand = esc(settings.brand_name || 'Мой IPTV-сервис');
  const tagline = esc(settings.tagline || 'Информационный канал аккаунта');
  const price = formatPrice(user.price_cents, user.currency);
  const statusFontSize = meta.label.length > 10 ? 27 : 32;

  return svgDoc(`
  <!-- Header -->
  <text x="80" y="92" fill="#ffffff" font-family="Inter, sans-serif" font-size="40" font-weight="700" letter-spacing="-0.5">${brand}</text>
  <text x="80" y="130" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">${tagline}</text>

  <!-- Card panel -->
  <rect x="64" y="170" width="1152" height="470" rx="24" fill="#0f1830" stroke="#24345f" stroke-width="1.5" filter="url(#soft)"/>

  <!-- Account -->
  <text x="104" y="248" fill="#7f93b5" font-family="Inter, sans-serif" font-size="22" letter-spacing="2">АККАУНТ</text>
  <text x="104" y="312" fill="#ffffff" font-family="Inter, sans-serif" font-size="58" font-weight="700" letter-spacing="-1">${esc(user.username)}</text>

  <!-- Status banner -->
  <rect x="820" y="214" width="356" height="86" rx="16" fill="${meta.color}"/>
  <circle cx="860" cy="257" r="12" fill="#ffffff" opacity="0.9"/>
  <text x="888" y="267" fill="#ffffff" font-family="Inter, sans-serif" font-size="${statusFontSize}" font-weight="800">${meta.label}</text>

  <!-- Divider -->
  <line x1="104" y1="372" x2="1176" y2="372" stroke="#24345f" stroke-width="1.5"/>

  <!-- Info grid -->
  <g font-family="Inter, sans-serif">
    <text x="104" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ТАРИФ</text>
    <text x="104" y="492" fill="#ffffff" font-size="44" font-weight="700">${esc(user.plan_name)}</text>

    <text x="464" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ЦЕНА</text>
    <text x="464" y="492" fill="#7dd3fc" font-size="44" font-weight="700">${esc(price)}</text>

    <text x="824" y="436" fill="#7f93b5" font-size="22" letter-spacing="2">ИСТЕКАЕТ</text>
    <text x="824" y="492" fill="#ffffff" font-size="44" font-weight="700">${esc(formatDate(user.expires_at))}</text>

    <text x="104" y="566" fill="#7f93b5" font-size="22" letter-spacing="2">ОСТАЛОСЬ ВРЕМЕНИ</text>
    <text x="104" y="612" fill="${meta.color}" font-size="40" font-weight="800">${esc(daysText)}</text>
  </g>

  <!-- Footer -->
  <text x="64" y="690" fill="#5c6e91" font-family="Inter, sans-serif" font-size="18">Обновлено ${esc(formatDate(localDateString()))} · Канал обновляется ежедневно</text>`);
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

// Expired accounts see the currently available plans instead of the regular
// details card. The common 2/3/4-plan cases are a single centered row.
export function buildExpiredPlansSvg(user, plans = [], settings = {}) {
  const brand = esc(settings.brand_name || 'Мой IPTV-сервис');
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
        <text x="${x + 42}" y="${fy}" fill="#c7d5eb" font-size="${featureFontSize}">${esc(clipText(feature, maxFeatureChars))}</text>`;
    }).join('');

    const moreRow = hiddenFeatureCount && maxFeatureRows
      ? `<text x="${x + 24}" y="${y + featureStart + features.length * featureLineHeight}" fill="#7f93b5" font-size="${featureFontSize}">+${hiddenFeatureCount} ещё</text>`
      : '';

    return `
      <g font-family="Inter, sans-serif">
        <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="${compact ? 14 : 20}" fill="#131f3d" stroke="${current ? '#38bdf8' : '#2b3d68'}" stroke-width="${current ? 3 : 1.5}"/>
        <text x="${x + 24}" y="${y + (compact ? 43 : 58)}" fill="#ffffff" font-size="${nameSize}" font-weight="700">${esc(clipText(plan.name, nameChars))}</text>
        <text x="${x + 24}" y="${y + (compact ? 82 : 119)}" fill="#7dd3fc" font-size="${priceSize}" font-weight="800">${esc(formatPrice(plan.price_cents, plan.currency))}</text>
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
  return svgDoc(`
    <text x="64" y="76" fill="#ffffff" font-family="Inter, sans-serif" font-size="34" font-weight="700" letter-spacing="-0.5">${brand}</text>
    <rect x="935" y="42" width="281" height="55" rx="14" fill="#dc2626"/>
    <text x="1075" y="79" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="24" font-weight="800">ПОДПИСКА ИСТЕКЛА</text>
    <text x="64" y="146" fill="#ffffff" font-family="Inter, sans-serif" font-size="42" font-weight="800" letter-spacing="-0.8">${esc(clipText(user.username, 34))}, выберите новый тариф</text>
    <text x="64" y="184" fill="#9fb3d1" font-family="Inter, sans-serif" font-size="22">Доступные планы для продления подписки</text>
    ${cards}
    ${emptyState}
    <text x="64" y="684" fill="#6f83a6" font-family="Inter, sans-serif" font-size="18">Свяжитесь с администратором, чтобы активировать выбранный тариф${extraCount ? ` · Ещё тарифов: ${extraCount}` : ''}</text>`);
}

// Backwards-compatible alias (older callers used buildSvg for the card).
export const buildSvg = buildCardSvg;

async function svgToPng(svg, outPath) {
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

// Render just the info card (used when the intro is disabled).
export async function renderCardPng(user, settings, outPath) {
  return svgToPng(buildCardSvg(user, settings), outPath);
}

export function buildBodySvg(user, plans = [], settings = {}) {
  const status = accountStatus(user, config.expiringThresholdDays);
  return status === 'expired'
    ? buildExpiredPlansSvg(user, plans, settings)
    : buildCardSvg(user, settings);
}

export async function renderBodyPng(user, settings, outPath, plans = []) {
  return svgToPng(buildBodySvg(user, plans, settings), outPath);
}

// Render the intro frames into dir. Returns { slide1, card } paths.
export async function renderSlidesPng(user, settings, dir, plans = []) {
  const out = {
    slide1: path.join(dir, 'slide1.png'),
    card: path.join(dir, 'card.png'),
  };
  await Promise.all([
    svgToPng(buildBrandSlide1Svg(settings), out.slide1),
    renderBodyPng(user, settings, out.card, plans),
  ]);
  return out;
}
