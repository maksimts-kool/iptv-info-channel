import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeNotices, applySetCookies, extractServiceNotices, htmlToParagraphs, isServiceNotice,
  languageSection, parseCookieHeader, summarizeNotice,
} from '../../src/news/notices.js';
import { localTimeToDate } from '../../src/core/util.js';

const TZ = 'Europe/Tallinn';

// Trimmed from a real tv.team /v3/news page: one maintenance notice among
// channel launches and removals.
const FEED = {
  data: {
    isManager: false,
    items: [
      {
        id: 8786,
        date: '14.09.2026 13:06:44',
        html: '<p>🇷🇺 RU ⚠️ Технические работы! Сообщаем, что часть телеканалов будет временно недоступна в течение нескольких часов в связи с плановой заменой архивных серверов. Обратите внимание: архивы на затрагиваемых каналах будут формироваться заново с момента завершения работ. Приносим извинения за временные неудобства и благодарим за понимание! 🛠️⚡️</p><p> 🇬🇧 EN ⚠️ Technical Maintenance Alert! Please be advised that some channels will be temporarily unavailable for a few hours due to scheduled archive server replacements. We apologize for any temporary inconvenience and appreciate your understanding! 🛠️⚡️</p>',
        isPublished: true,
      },
      {
        id: 8765,
        date: '12.09.2026 18:32:09',
        html: '<p>🇷🇺 RU</p><p>📺 <strong>«TEAM СМЕРШ-ТВ» </strong>с 12 сентября! 🎬</p><p>Круглосуточный канал военно-исторических и криминальных детективов XX века: шпионские и ретро-сериалы («Ликвидация», «Место встречи изменить нельзя» и др.).</p><p>👉 Обновляйте плейлисты! 🔄</p><p>🇬🇧 EN</p><p>📺 <strong>&#34;TEAM SMERSH-TV&#34;</strong> from Sept 12! 🎬</p><p>👉 Update playlists! 🔄</p><p>📂 VIP | 🇷🇺 Россия | 📦 Базовый | ⏱ Повременка</p>',
        isPublished: true,
      },
      {
        id: 8745,
        date: '11.09.2026 18:56:04',
        html: '<p>🇷🇺 RU</p><p>📺 Обновление в пакете BCUMedia! 🚀✨</p><p><strong>BCU Cosmo HD</strong> завершает вещание. На этой частоте запускается семейный канал <strong>BCU Family HDR</strong>!</p><p>👉 Обновляйте плейлисты! 🔄🍿</p><p>🇬🇧 EN</p><p>📺 BCUMedia package update! 🚀✨</p>',
        isPublished: true,
      },
      {
        id: 8728,
        date: '10.09.2026 09:02:34',
        html: '<p>🇷🇺 RU</p><p>ℹ️ <strong>Изменения в пакете «Армения»</strong></p><p>Сообщаем, что каналы Nur и Shant Premium USA завершили свое вещание и были удалены из списков.</p><p>Приносим извинения за неудобства и рекомендуем обновить ваши плейлисты. 📡🔄</p><p>🇬🇧 EN</p><p>ℹ️ <strong>Changes to the &#34;Armenia&#34; Package</strong></p><p>Please be advised that the channels Nur and Shant Premium USA have ceased broadcasting and have been removed from the lists.</p>',
        isPublished: true,
      },
      {
        id: 8725,
        date: '09.09.2026 09:53:15',
        html: '<p>🇷🇺 RU</p><p>📺 <strong>TEAM Большие Идеи HD </strong>с 9 сентября! 🧠💡</p><p>🎧 Звук: Оригинал (EN) / Нейродубляж (RU).</p><p>📍 Раздел: «Авторские каналы». Обновляйте плейлисты! 🔄</p><p>🇬🇧 EN</p><p>24/7 interviews by Lex Fridman &amp; CEO on AI, business &amp; future.</p>',
        isPublished: true,
      },
      {
        id: 8685,
        date: '05.09.2026 13:32:55',
        html: '<p>🇷🇺 RU</p><p>📺 Новый канал <strong>«TEAM Квартирник»</strong> с 5 сентября! 🎸🎙️</p><p>Живой звук и душевная атмосфера. В эфире 24/7: выступления поп и рок исполнителей, беседы и джемы без фонограммы!</p><p>🇬🇧 EN</p><p>24/7 live sound and cozy sessions, no lip-syncing!</p>',
        isPublished: true,
      },
    ],
    totalPages: 57,
  },
};

test('only the maintenance notice survives; channel news is dropped', () => {
  const notices = extractServiceNotices(FEED, { tz: TZ });
  assert.equal(notices.length, 1);
  const [n] = notices;
  assert.equal(n.id, '8786');
  assert.equal(n.kind, 'maintenance');
  assert.equal(n.headline, 'Технические работы');
  assert.match(n.body, /^Сообщаем, что часть телеканалов будет временно недоступна/);
  assert.match(n.body, /с момента завершения работ\.$/);
  // RU only, no emoji, no apology boilerplate.
  assert.doesNotMatch(n.body, /Maintenance|Приносим извинения|[\u{1F300}-\u{1FAFF}]/u);
  // The provider's wall clock, read in the configured timezone (EEST = UTC+3).
  assert.equal(n.published_at, localTimeToDate(2026, 9, 14, 13, 6, 44, TZ).toISOString());
  assert.equal(n.published_at, '2026-09-14T10:06:44.000Z');
});

test('unpublished items are ignored', () => {
  const feed = { data: { items: [{ ...FEED.data.items[0], isPublished: false }] } };
  assert.deepEqual(extractServiceNotices(feed, { tz: TZ }), []);
});

test('isServiceNotice recognises outages and not channel line-up changes', () => {
  for (const text of [
    'Наблюдаются перебои с вещанием некоторых каналов',
    'Сбой на одном из серверов, специалисты уже работают',
    'Проблемы с воспроизведением архива на части каналов',
    'Вещание всех каналов восстановлено',
    'Some channels are temporarily unavailable',
  ]) assert.equal(isServiceNotice(text), true, text);
  for (const text of [
    'Сборник лучших фильмов на новом канале',
    'Каналы завершили свое вещание и были удалены из списков',
    'Новый канал с 5 сентября! Обновляйте плейлисты!',
  ]) assert.equal(isServiceNotice(text), false, text);
});

test('languageSection handles one-paragraph and split-paragraph items', () => {
  const inline = htmlToParagraphs(FEED.data.items[0].html).join('\n');
  assert.match(languageSection(inline, 'RU'), /^⚠️ Технические работы!/);
  assert.doesNotMatch(languageSection(inline, 'RU'), /Technical/);

  const split = htmlToParagraphs(FEED.data.items[1].html).join('\n');
  const ru = languageSection(split, 'RU');
  assert.match(ru, /СМЕРШ-ТВ/);
  assert.doesNotMatch(ru, /SMERSH/);
  // "🇷🇺 Россия" in the footer is not a language marker.
  assert.match(languageSection(split, 'EN'), /Россия/);
});

test('htmlToParagraphs decodes the entities the feed uses', () => {
  assert.deepEqual(
    htmlToParagraphs('<p><strong>&#34;A&#34;</strong> &amp; B&#39;s</p><p></p><p>x&nbsp;y</p>'),
    ['"A" & B\'s', 'x y'],
  );
});

test('summarizeNotice falls back to the kind label without a short opener', () => {
  assert.deepEqual(
    summarizeNotice('Сейчас наблюдаются перебои с вещанием части каналов. Приносим извинения.', 'outage'),
    { headline: 'Перебои в работе', body: 'Сейчас наблюдаются перебои с вещанием части каналов.' },
  );
});

test('activeNotices keeps only notices inside the age window', () => {
  const notices = [
    { id: 'new', published_at: '2026-09-14T10:00:00.000Z' },
    { id: 'old', published_at: '2026-09-12T10:00:00.000Z' },
  ];
  const now = new Date('2026-09-14T20:00:00Z');
  assert.deepEqual(activeNotices(notices, { now, maxAgeHours: 24 }).map((n) => n.id), ['new']);
  assert.deepEqual(activeNotices(notices, { now, maxAgeHours: 72 }).map((n) => n.id), ['new', 'old']);
});

test('applySetCookies rotates, adds and expires cookies', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  const next = applySetCookies('Cookie: access=old; refresh=r1; theme=dark', [
    'access=new; Path=/; HttpOnly; Secure; SameSite=None',
    'refresh=r2; Expires=Wed, 14 Oct 2026 12:00:00 GMT; Path=/v3/auth',
    'theme=; Max-Age=0',
    'csrf=abc==; Path=/',
  ], now);
  assert.equal(next, 'access=new; refresh=r2; csrf=abc==');
  assert.equal(applySetCookies('a=1', ['a=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], now), '');
  assert.deepEqual([...parseCookieHeader('a=1;\n b = 2 ;junk')], [['a', '1'], ['b', '2']]);
});
