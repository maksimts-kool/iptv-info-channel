// World Cup 2026 data for the auto-updating tournament slide.
//
// The slide is a chronological *match list* of the knockout stage only (1/16
// final onward — no group games). `buildWorldCupModel` flattens the knockout
// matches into one timeline and `selectWindow` picks an adaptive window around
// "today" (a couple of recent results, anything live, then the next fixtures).
// Before the knockout starts it shows a "playoffs start on <date>" message, and
// once the Final is played it switches to a champion summary.
//
// Two data layers feed it:
//   1. BRACKET_2026 — a static skeleton of the 31 knockout matches (Round of 32
//      through the Final + third-place match). For the Round of 32 it carries the
//      real FIFA seeding placeholders, dates and venues (transcribed from the
//      official bracket, in Russian), so upcoming knockout matches render with
//      meaningful labels before any team is known.
//   2. Live results, fetched daily from a free football API (football-data.org by
//      default) and merged onto the skeleton. With no API token the slide shows
//      the knockout skeleton (seeding placeholders, no live teams/scores).
//
// Pure logic (skeleton + buildBracketModel + buildWorldCupModel) is unit-tested;
// the network fetch is best-effort and degrades to the skeleton on any error.
import { config } from './config.js';
import { formatDate, formatTime, localDateString } from './util.js';
import { log } from './logger.js';

// ---- Static knockout skeleton (official 2026 seeding, Russian) ----

// Round of 32 (matches 73–88), top-to-bottom as drawn on the official bracket.
// Each: [id, ISO date, venue, home seed label, away seed label].
const R32 = [
  [73, '2026-06-29', 'Фоксборо', 'Германия', '3-е место в группе A/B/C/D/F'],
  [74, '2026-06-30', 'Ист-Ратерфорд', 'Победитель группы I', '3-е место в группе C/D/F/G/H'],
  [75, '2026-06-28', 'Инглвуд', 'Второе место в группе A', 'Второе место в группе B'],
  [76, '2026-06-29', 'Гуадалупе', 'Победитель группы F', 'Второе место в группе C'],
  [77, '2026-07-02', 'Торонто', 'Второе место в группе K', 'Второе место в группе L'],
  [78, '2026-07-02', 'Инглвуд', 'Победитель группы H', 'Второе место в группе J'],
  [79, '2026-07-01', 'Санта-Клара', 'США', '3-е место в группе B/E/F/I/J'],
  [80, '2026-07-01', 'Сиэтл', 'Победитель группы G', '3-е место в группе A/E/H/I/J'],
  [81, '2026-06-29', 'Хьюстон', 'Победитель группы C', 'Второе место в группе F'],
  [82, '2026-06-30', 'Арлингтон', 'Второе место в группе E', 'Второе место в группе I'],
  [83, '2026-06-30', 'Мехико', 'Мексика', '3-е место в группе C/E/F/H/I'],
  [84, '2026-07-01', 'Атланта', 'Победитель группы L', '3-е место в группе E/H/I/J/K'],
  [85, '2026-07-03', 'Майами-Гарденс', 'Аргентина', 'Второе место в группе H'],
  [86, '2026-07-03', 'Арлингтон', 'Второе место в группе D', 'Второе место в группе G'],
  [87, '2026-07-02', 'Ванкувер', 'Победитель группы B', '3-е место в группе E/F/G/I/J'],
  [88, '2026-07-03', 'Канзас-Сити', 'Победитель группы K', '3-е место в группе D/E/I/J/L'],
];

// Later rounds (id, ISO date, venue). The two competitors are filled from the
// API; before resolution they show the neutral "winner" placeholder. The tree
// is drawn by simple top-to-bottom adjacency (match j is fed by the two matches
// above it), which is the conventional single-elimination layout.
const R16 = [
  [89, '2026-07-04', 'Филадельфия'],
  [90, '2026-07-04', 'Хьюстон'],
  [91, '2026-07-06', 'Арлингтон'],
  [92, '2026-07-06', 'Сиэтл'],
  [93, '2026-07-05', 'Ист-Ратерфорд'],
  [94, '2026-07-05', 'Мехико'],
  [95, '2026-07-07', 'Атланта'],
  [96, '2026-07-07', 'Ванкувер'],
];
const QF = [
  [97, '2026-07-09', 'Фоксборо'],
  [98, '2026-07-10', 'Инглвуд'],
  [99, '2026-07-11', 'Майами-Гарденс'],
  [100, '2026-07-11', 'Канзас-Сити'],
];
const SF = [
  [101, '2026-07-14', 'Арлингтон'],
  [102, '2026-07-15', 'Атланта'],
];
const FINAL = [[104, '2026-07-19', 'Ист-Ратерфорд']];
const THIRD = [103, '2026-07-18', 'Майами-Гарденс'];

const WINNER_PLACEHOLDER = 'Победитель';
const LOSER_PLACEHOLDER = 'Проигравший в полуфинале';

function seedMatch([id, date, venue, home, away]) {
  return { id, date, venue, home: home ?? WINNER_PLACEHOLDER, away: away ?? WINNER_PLACEHOLDER };
}

// Russian titles + short labels per round, used by the slide header/columns.
export const ROUND_META = {
  r32: { title: '1/16 финала', short: '1/16' },
  r16: { title: '1/8 финала', short: '1/8' },
  qf: { title: '1/4 финала', short: '1/4' },
  sf: { title: 'Полуфиналы', short: '1/2' },
  final: { title: 'Финал', short: 'Финал' },
};

// The skeleton consumed by buildBracketModel. Rounds are ordered R32 → Final;
// the third-place match is carried alongside the Final column.
export const BRACKET_2026 = {
  rounds: [
    { key: 'r32', matches: R32.map(seedMatch) },
    { key: 'r16', matches: R16.map(seedMatch) },
    { key: 'qf', matches: QF.map(seedMatch) },
    { key: 'sf', matches: SF.map(seedMatch) },
    { key: 'final', matches: FINAL.map(seedMatch) },
  ],
  thirdPlace: {
    id: THIRD[0], date: THIRD[1], venue: THIRD[2], home: LOSER_PLACEHOLDER, away: LOSER_PLACEHOLDER,
  },
};

// API status string -> on-card status. `null` colour means "just show the date".
export const WC_STATUS = {
  scheduled: { key: 'scheduled', label: 'по расписанию', color: null },
  live: { key: 'live', label: 'В ЭФИРЕ', color: '#dc2626' },
  finished: { key: 'finished', label: 'завершён', color: '#16a34a' },
  postponed: { key: 'postponed', label: 'перенесён', color: '#d97706' },
};

function normalizeStatus(apiStatus) {
  switch (apiStatus) {
    case 'IN_PLAY':
    case 'PAUSED':
    case 'LIVE':
      return WC_STATUS.live;
    case 'FINISHED':
    case 'AWARDED':
      return WC_STATUS.finished;
    case 'POSTPONED':
    case 'SUSPENDED':
    case 'CANCELLED':
      return WC_STATUS.postponed;
    default:
      return WC_STATUS.scheduled;
  }
}

// English football-data team names -> Russian. Falls back to the source name for
// anything not listed, so an unexpected qualifier still renders (just untranslated).
const NATION_RU = {
  Germany: 'Германия', France: 'Франция', England: 'Англия', Spain: 'Испания',
  Portugal: 'Португалия', Netherlands: 'Нидерланды', Belgium: 'Бельгия', Italy: 'Италия',
  Croatia: 'Хорватия', Switzerland: 'Швейцария', Denmark: 'Дания', Poland: 'Польша',
  Austria: 'Австрия', Serbia: 'Сербия', Ukraine: 'Украина', Norway: 'Норвегия',
  Sweden: 'Швеция', Turkey: 'Турция', 'Czech Republic': 'Чехия', Scotland: 'Шотландия',
  Wales: 'Уэльс', Hungary: 'Венгрия', Greece: 'Греция', Romania: 'Румыния',
  Brazil: 'Бразилия', Argentina: 'Аргентина', Uruguay: 'Уругвай', Colombia: 'Колумбия',
  Ecuador: 'Эквадор', Chile: 'Чили', Peru: 'Перу', Paraguay: 'Парагвай',
  Mexico: 'Мексика', USA: 'США', 'United States': 'США', Canada: 'Канада',
  'Costa Rica': 'Коста-Рика', Panama: 'Панама', Honduras: 'Гондурас', Jamaica: 'Ямайка',
  Japan: 'Япония', 'Korea Republic': 'Республика Корея', 'South Korea': 'Республика Корея',
  'Iran': 'Иран', 'IR Iran': 'Иран', 'Saudi Arabia': 'Саудовская Аравия', Australia: 'Австралия',
  Qatar: 'Катар', Iraq: 'Ирак', 'United Arab Emirates': 'ОАЭ', Uzbekistan: 'Узбекистан',
  Morocco: 'Марокко', Senegal: 'Сенегал', Tunisia: 'Тунис', Algeria: 'Алжир',
  Egypt: 'Египет', Nigeria: 'Нигерия', Ghana: 'Гана', Cameroon: 'Камерун',
  'Ivory Coast': 'Кот-д’Ивуар', "Cote d'Ivoire": 'Кот-д’Ивуар', 'South Africa': 'ЮАР',
  'Cape Verde': 'Кабо-Верде', 'New Zealand': 'Новая Зеландия', 'Jordan': 'Иордания',
};

export function nationName(name) {
  if (!name) return null;
  return NATION_RU[name] || name;
}

// ---- Skeleton + results -> render model (pure) ----

// Resolve a pair of competitors + scores into the on-card shape, applying the
// English->Russian map and (for finished matches with a score) a winner flag.
// `fallbackHome`/`fallbackAway` supply the seed label when no team is known yet.
function resolveCompetitors({
  homeName, awayName, homeScore, awayScore, finished,
  fallbackHome = null, fallbackAway = null,
}) {
  const hasScore = Number.isFinite(homeScore) && Number.isFinite(awayScore);
  return {
    home: {
      label: nationName(homeName) || fallbackHome,
      score: hasScore ? homeScore : null,
      winner: hasScore && finished && homeScore > awayScore,
    },
    away: {
      label: nationName(awayName) || fallbackAway,
      score: hasScore ? awayScore : null,
      winner: hasScore && finished && awayScore > homeScore,
    },
  };
}

// One skeleton match merged with its (optional) API result into render shape.
function decorateMatch(match, result, tz) {
  const status = normalizeStatus(result?.status);
  const kickoff = result?._kickoff || result?.kickoff || null;
  // Derive the displayed day from the kickoff in the local timezone so the date
  // and time agree (a 30 Jun 21:00 UTC match is "1 июл 00:00" in Tallinn, not
  // "30 июн 00:00"). Skeleton-only matches keep their fixed calendar date.
  const date = kickoff ? localDateString(new Date(kickoff), tz) : (result?.date || match.date);
  const { home, away } = resolveCompetitors({
    homeName: result?.home,
    awayName: result?.away,
    homeScore: result?.homeScore,
    awayScore: result?.awayScore,
    finished: status.key === 'finished',
    fallbackHome: match.home,
    fallbackAway: match.away,
  });
  return {
    id: match.id,
    date,
    dateLabel: shortDate(date),
    time: formatTime(kickoff, tz),
    kickoff,
    venue: match.venue,
    status,
    home,
    away,
  };
}

// `results` is keyed by round key (r32/r16/qf/sf/final/third) -> array of
// per-match results in the same order as the skeleton, each:
//   { home, away, homeScore, awayScore, status, date }
// Any field may be missing; missing competitors fall back to the seed label.
export function buildBracketModel(
  skeleton = BRACKET_2026,
  results = {},
  { now = new Date(), tz = config.timezone } = {},
) {
  const todayStr = localDateString(now, tz);
  const rounds = skeleton.rounds.map((round) => ({
    key: round.key,
    title: ROUND_META[round.key]?.title || round.key,
    matches: round.matches.map((m, i) => decorateMatch(m, results[round.key]?.[i], tz)),
  }));
  const thirdPlace = decorateMatch(skeleton.thirdPlace, results.third?.[0], tz);

  return {
    rounds,
    thirdPlace,
    headline: phaseHeadline(skeleton, todayStr),
    updated: formatDate(todayStr),
  };
}

// ---- Flat match timeline + adaptive window (pure) ----

const THIRD_PLACE_LABEL = 'Матч за 3-е место';

// Decorated match -> flat fixture row for the list slide.
function toFixture(match, stageLabel) {
  return {
    id: match.id,
    date: match.date,
    dateLabel: match.dateLabel,
    time: match.time,
    stageLabel,
    status: match.status,
    home: match.home,
    away: match.away,
    _sort: match.kickoff || `${match.date}T00:00:00Z`,
  };
}

// Knockout fixtures: the skeleton merged with API results, flattened in round
// order (each match tagged with its round title, plus the third-place match).
function knockoutFixtures(skeleton, results, opts) {
  const model = buildBracketModel(skeleton, results, opts);
  const out = [];
  for (const round of model.rounds) {
    const label = ROUND_META[round.key]?.title || round.key;
    for (const match of round.matches) out.push(toFixture(match, label));
  }
  out.push(toFixture(model.thirdPlace, THIRD_PLACE_LABEL));
  return out;
}

// Adaptive window: up to PAST_COUNT most-recent finished matches, then live and
// upcoming fixtures filling out to WINDOW_SIZE. If everything has finished, show
// the last WINDOW_SIZE results.
const PAST_COUNT = 2;
const WINDOW_SIZE = 6;

function selectWindow(fixtures) {
  const pivot = fixtures.findIndex((f) => f.status.key !== 'finished');
  if (pivot === -1) return fixtures.slice(Math.max(0, fixtures.length - WINDOW_SIZE));

  let start = Math.max(0, pivot - PAST_COUNT);
  let picked = fixtures.slice(start, start + WINDOW_SIZE);
  // If there weren't enough upcoming matches to fill the window, reach further
  // back into past results so the slide stays full.
  if (picked.length < WINDOW_SIZE && start > 0) {
    start = Math.max(0, fixtures.length - WINDOW_SIZE);
    picked = fixtures.slice(start, start + WINDOW_SIZE);
  }
  return picked;
}

// Champion summary once the Final has a winner, else null.
function detectChampion(knockout) {
  const finalFx = knockout.find((f) => f.stageLabel === ROUND_META.final.title);
  if (!finalFx || finalFx.status.key !== 'finished') return null;
  const { home, away } = finalFx;
  const champ = home.winner ? home : away.winner ? away : null;
  if (!champ) return null;
  const runner = champ === home ? away : home;
  return {
    team: champ.label,
    runnerUp: runner.label,
    champScore: champ.score,
    runnerScore: runner.score,
    date: finalFx.dateLabel,
  };
}

// Earliest date in the knockout skeleton (the first 1/16 match).
function knockoutStart(skeleton) {
  return skeleton.rounds[0].matches
    .map((m) => m.date)
    .reduce((min, d) => (d < min ? d : min));
}

// "28 июня" — day + genitive month, for the "playoffs start on" message.
const GENITIVE_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[3])} ${GENITIVE_MONTHS[Number(m[2]) - 1]}` : '';
}

// The render model consumed by buildWorldCupSlideSvg. The slide only ever shows
// knockout matches (1/16 final onward — no group stage). Before the knockout
// starts it carries a `notStarted` message; once the Final is decided, a
// `champion` summary; otherwise an adaptive window of fixtures around today.
export function buildWorldCupModel(
  skeleton = BRACKET_2026,
  apiMatches = [],
  { now = new Date(), tz = config.timezone } = {},
) {
  const todayStr = localDateString(now, tz);
  const knockout = knockoutFixtures(skeleton, groupResults(apiMatches), { now, tz })
    .sort((a, b) => a._sort.localeCompare(b._sort));
  const champion = detectChampion(knockout);
  const notStarted = !champion && todayStr < knockoutStart(skeleton)
    ? { startLabel: longDate(knockoutStart(skeleton)) }
    : null;

  return {
    headline: phaseHeadline(skeleton, todayStr),
    updated: formatDate(todayStr),
    champion,
    notStarted,
    fixtures: notStarted ? [] : selectWindow(knockout),
  };
}

// "09 июн" — day + short month, no year (bracket cells are tight).
function shortDate(iso) {
  const formatted = formatDate(iso); // "09 июн 2026"
  return formatted === '—' ? '—' : formatted.replace(/\s+\d{4}$/, '');
}

// Current phase label from today's date vs. the round date windows.
function phaseHeadline(skeleton, todayStr) {
  const windows = skeleton.rounds.map((round) => {
    const dates = round.matches.map((m) => m.date).sort();
    return { key: round.key, min: dates[0], max: dates[dates.length - 1] };
  });
  const firstStart = windows[0].min;
  if (todayStr < firstStart) {
    return `Плей-офф · старт ${shortDate(firstStart)}`;
  }
  const current = windows.find((w) => todayStr <= w.max);
  if (!current) return 'Чемпионат мира 2026 · завершён';
  const label = ROUND_META[current.key]?.title || current.key;
  return todayStr < current.min ? `Далее: ${label}` : label;
}

// ---- Live fetch (best-effort, football-data.org v4) ----

const STAGE_TO_ROUND = {
  LAST_32: 'r32',
  ROUND_OF_32: 'r32',
  LAST_16: 'r16',
  ROUND_OF_16: 'r16',
  QUARTER_FINALS: 'qf',
  QUARTER_FINAL: 'qf',
  SEMI_FINALS: 'sf',
  SEMI_FINAL: 'sf',
  THIRD_PLACE: 'third',
  FINAL: 'final',
};

// Fetch every match of the competition (all stages). Returns [] on any failure
// (no token, network error, non-200, bad JSON) so the slide degrades to the
// seeding skeleton instead of breaking the encode.
export async function fetchAllMatches({
  token = config.footballApi.token,
  base = config.footballApi.base,
  competition = config.footballApi.competition,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (!token) return [];
  const url = `${base}/competitions/${encodeURIComponent(competition)}/matches`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'X-Auth-Token': token },
      signal: signal || AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log.warn('worldcup', 'results fetch returned non-200', { status: res.status });
      return [];
    }
    const data = await res.json();
    return data.matches || [];
  } catch (err) {
    log.warn('worldcup', 'results fetch failed; using bracket skeleton', { error: err.message });
    return [];
  }
}

// Knockout results grouped by round, ordered by kickoff so they line up with the
// skeleton's top-to-bottom match order. Returns {} on any fetch failure.
export async function fetchWorldCupResults(opts = {}) {
  return groupResults(await fetchAllMatches(opts));
}

function groupResults(matches) {
  const byRound = {};
  for (const m of matches) {
    const round = STAGE_TO_ROUND[m.stage];
    if (!round) continue;
    (byRound[round] ||= []).push({
      home: m.homeTeam?.name || m.homeTeam?.shortName || null,
      away: m.awayTeam?.name || m.awayTeam?.shortName || null,
      homeScore: m.score?.fullTime?.home ?? null,
      awayScore: m.score?.fullTime?.away ?? null,
      status: m.status,
      date: (m.utcDate || '').slice(0, 10) || null,
      _kickoff: m.utcDate || '',
    });
  }
  for (const round of Object.keys(byRound)) {
    byRound[round].sort((a, b) => a._kickoff.localeCompare(b._kickoff));
  }
  return byRound;
}

// ---- Cached summary used by the encode pipeline ----

let cache = null; // { matches, at }

// Returns the fixture-list model (skeleton + cached live results), or null when
// the slide is disabled. Re-fetches when the cache is older than the configured
// TTL or when `force` is set (the daily refresh / startup pass `force`).
export async function getWorldCupSummary({ now = new Date(), force = false } = {}) {
  if (!config.worldcupSlide.enabled) return null;
  const ttlMs = config.footballApi.ttlMinutes * 60 * 1000;
  let matches;
  if (!force && cache && Date.now() - cache.at < ttlMs) {
    matches = cache.matches;
  } else {
    matches = await fetchAllMatches();
    cache = { matches, at: Date.now() };
  }
  return buildWorldCupModel(BRACKET_2026, matches, { now });
}

// Force a refresh of the cached results (startup pre-gen + daily cron call this
// so each generateAll batch fetches at most once).
export async function refreshWorldCup() {
  if (!config.worldcupSlide.enabled) return null;
  return getWorldCupSummary({ force: true });
}
