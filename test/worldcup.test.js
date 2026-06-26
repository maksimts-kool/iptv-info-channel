import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRACKET_2026, buildBracketModel, buildWorldCupModel, fetchWorldCupResults, nationName,
  getWorldCupModel, getWorldCupSummary,
} from '../src/worldcup.js';
import { buildWorldCupSlideSvg } from '../src/overlay.js';
import { config } from '../src/config.js';

// Helper: a football-data-shaped match object.
function apiMatch({ stage, group, date, status, home, away, hs = null, as = null }) {
  return {
    stage,
    group,
    utcDate: date,
    status,
    homeTeam: home ? { name: home } : undefined,
    awayTeam: away ? { name: away } : undefined,
    score: { fullTime: { home: hs, away: as } },
  };
}

test('skeleton has the full 31-match knockout tree', () => {
  const counts = Object.fromEntries(BRACKET_2026.rounds.map((r) => [r.key, r.matches.length]));
  assert.deepEqual(counts, { r32: 16, r16: 8, qf: 4, sf: 2, final: 1 });
  assert.ok(BRACKET_2026.thirdPlace);
  // R32 carries real seeding labels + venues from the official bracket.
  assert.equal(BRACKET_2026.rounds[0].matches[0].home, 'Германия');
  assert.equal(BRACKET_2026.rounds[0].matches[0].venue, 'Фоксборо');
});

test('buildBracketModel renders the skeleton with placeholders when no results', () => {
  const model = buildBracketModel(BRACKET_2026, {}, { now: new Date('2026-07-01T12:00:00Z') });
  assert.equal(model.rounds.length, 5);
  const r32 = model.rounds[0];
  assert.equal(r32.matches.length, 16);
  // First R32 match keeps its seed labels and a short date.
  assert.equal(r32.matches[0].home.label, 'Германия');
  assert.equal(r32.matches[0].away.label, '3-е место в группе A/B/C/D/F');
  assert.equal(r32.matches[0].home.score, null);
  assert.match(r32.matches[0].dateLabel, /29 июн/);
  // Later-round competitors are still the "winner" placeholder.
  assert.equal(model.rounds[4].matches[0].home.label, 'Победитель');
});

test('phase headline tracks the calendar', () => {
  const before = buildBracketModel(BRACKET_2026, {}, { now: new Date('2026-06-20T12:00:00Z') });
  assert.match(before.headline, /старт/);
  const during = buildBracketModel(BRACKET_2026, {}, { now: new Date('2026-07-01T12:00:00Z') });
  assert.equal(during.headline, '1/16 финала');
  const after = buildBracketModel(BRACKET_2026, {}, { now: new Date('2026-07-25T12:00:00Z') });
  assert.match(after.headline, /завершён/);
});

test('buildBracketModel merges live results onto the skeleton', () => {
  const results = {
    r16: [
      {
        home: 'Germany', away: 'Croatia', homeScore: 2, awayScore: 1,
        status: 'FINISHED', date: '2026-07-04',
      },
      {
        home: 'Spain', away: 'Morocco', homeScore: null, awayScore: null,
        status: 'IN_PLAY', date: '2026-07-04',
      },
    ],
  };
  const model = buildBracketModel(BRACKET_2026, results, { now: new Date('2026-07-04T18:00:00Z') });
  const r16 = model.rounds[1];

  const finished = r16.matches[0];
  assert.equal(finished.home.label, 'Германия'); // English -> Russian
  assert.equal(finished.away.label, 'Хорватия');
  assert.equal(finished.home.score, 2);
  assert.equal(finished.home.winner, true);
  assert.equal(finished.away.winner, false);
  assert.equal(finished.status.key, 'finished');

  const live = r16.matches[1];
  assert.equal(live.status.key, 'live');
  assert.equal(live.home.winner, false); // no winner mid-match
});

test('nationName falls back to the source name when unmapped', () => {
  assert.equal(nationName('Germany'), 'Германия');
  assert.equal(nationName('Atlantis'), 'Atlantis');
  assert.equal(nationName(null), null);
});

test('fetchWorldCupResults groups knockout matches by round, ordered by kickoff', async () => {
  const payload = {
    matches: [
      { stage: 'GROUP_STAGE', utcDate: '2026-06-15T16:00:00Z', status: 'FINISHED' }, // ignored
      {
        stage: 'LAST_16', utcDate: '2026-07-04T20:00:00Z', status: 'TIMED',
        homeTeam: { name: 'Spain' }, awayTeam: { name: 'Morocco' }, score: { fullTime: { home: null, away: null } },
      },
      {
        stage: 'LAST_16', utcDate: '2026-07-04T16:00:00Z', status: 'FINISHED',
        homeTeam: { name: 'Germany' }, awayTeam: { name: 'Croatia' }, score: { fullTime: { home: 2, away: 1 } },
      },
      {
        stage: 'FINAL', utcDate: '2026-07-19T19:00:00Z', status: 'TIMED',
        homeTeam: { name: 'France' }, awayTeam: { name: 'Brazil' }, score: { fullTime: { home: null, away: null } },
      },
    ],
  };
  const fetchImpl = async () => ({ ok: true, json: async () => payload });
  const results = await fetchWorldCupResults({ token: 'x', fetchImpl });

  assert.equal(results.r16.length, 2);
  // Earlier kickoff first, so the skeleton's top-to-bottom order lines up.
  assert.equal(results.r16[0].home, 'Germany');
  assert.equal(results.r16[1].home, 'Spain');
  assert.equal(results.final[0].home, 'France');
  assert.equal(results.r32, undefined); // group-stage entry dropped
});

test('fetchWorldCupResults degrades to {} without a token or on error', async () => {
  assert.deepEqual(await fetchWorldCupResults({ token: '' }), {});
  const boom = async () => { throw new Error('network down'); };
  assert.deepEqual(await fetchWorldCupResults({ token: 'x', fetchImpl: boom }), {});
  const notOk = async () => ({ ok: false, status: 429 });
  assert.deepEqual(await fetchWorldCupResults({ token: 'x', fetchImpl: notOk }), {});
});

test('buildWorldCupModel shows a start message before the knockout begins', () => {
  const model = buildWorldCupModel(BRACKET_2026, [], { now: new Date('2026-06-23T12:00:00Z') });
  assert.equal(model.champion, null);
  assert.ok(model.notStarted);
  assert.equal(model.notStarted.startLabel, '28 июня'); // first 1/16 match
  assert.equal(model.fixtures.length, 0);
});

test('buildWorldCupModel lists upcoming knockout placeholders once it has started', () => {
  const model = buildWorldCupModel(BRACKET_2026, [], { now: new Date('2026-06-29T12:00:00Z') });
  assert.equal(model.notStarted, null);
  assert.equal(model.fixtures.length, 6); // adaptive window fills to 6
  // The earliest 1/16 match (28 June) leads, tagged with its round.
  assert.equal(model.fixtures[0].stageLabel, '1/16 финала');
  assert.match(model.fixtures[0].dateLabel, /28 июн/);
  // Never any group-stage fixtures.
  assert.ok(model.fixtures.every((f) => !/Группа/.test(f.stageLabel)));
});

test('buildWorldCupModel windows around today: ≤2 past, live, then upcoming (knockout only)', () => {
  const k = (date, status, home, away, hs = null, as = null) =>
    apiMatch({ stage: 'ROUND_OF_32', date, status, home, away, hs, as });
  const matches = [
    k('2026-06-28T16:00:00Z', 'FINISHED', 'Germany', 'Scotland', 2, 0),
    k('2026-06-28T19:00:00Z', 'FINISHED', 'Spain', 'Italy', 1, 0),
    k('2026-06-29T18:00:00Z', 'IN_PLAY', 'Brazil', 'Argentina'),
    k('2026-06-29T21:00:00Z', 'TIMED', 'France', 'Poland'),
  ];
  const model = buildWorldCupModel(BRACKET_2026, matches, { now: new Date('2026-06-29T18:30:00Z') });

  assert.equal(model.notStarted, null);
  assert.equal(model.fixtures.length, 6);
  // The live match is present and flagged.
  const live = model.fixtures.find((f) => f.status.key === 'live');
  assert.ok(live);
  assert.equal(live.home.label, 'Бразилия');
  // Every row is a knockout round (no group stage), and a kickoff time surfaces.
  assert.ok(model.fixtures.every((f) => !/Группа/.test(f.stageLabel)));
  assert.ok(model.fixtures.every((f) => /финала|Финал|3-е место/.test(f.stageLabel)));
  const timed = model.fixtures.find((f) => f.time);
  assert.match(timed.time, /^\d\d:\d\d$/);
});

test('buildWorldCupModel surfaces a champion once the final is decided', () => {
  const matches = [
    apiMatch({ stage: 'FINAL', date: '2026-07-19T19:00:00Z', status: 'FINISHED', home: 'France', away: 'Brazil', hs: 2, as: 1 }),
  ];
  const model = buildWorldCupModel(BRACKET_2026, matches, { now: new Date('2026-07-20T12:00:00Z') });
  assert.ok(model.champion);
  assert.equal(model.champion.team, 'Франция');
  assert.equal(model.champion.runnerUp, 'Бразилия');
  assert.equal(model.champion.champScore, 2);
  assert.equal(model.champion.runnerScore, 1);
});

test('match-list SVG renders the header, fixtures and escapes team text', () => {
  const matches = [
    apiMatch({ stage: 'ROUND_OF_32', date: '2026-06-28T16:00:00Z', status: 'IN_PLAY', home: 'A & B', away: 'Croatia' }),
  ];
  const model = buildWorldCupModel(BRACKET_2026, matches, { now: new Date('2026-06-28T17:00:00Z') });
  const svg = buildWorldCupSlideSvg(model, { brand_name: 'IPTV Test' });

  assert.match(svg, /Чемпионат мира 2026/);
  assert.match(svg, /Расписание матчей/); // list footer (no more bracket)
  assert.match(svg, /1\/16 финала/);
  assert.match(svg, /В ЭФИРЕ/); // live status badge
  assert.match(svg, /A &amp; B/);
  assert.doesNotMatch(svg, /A & B</);
  assert.doesNotMatch(svg, /Группа/); // knockout only
});

test('not-started SVG renders the playoffs start message', () => {
  const model = buildWorldCupModel(BRACKET_2026, [], { now: new Date('2026-06-23T12:00:00Z') });
  const svg = buildWorldCupSlideSvg(model, { brand_name: 'IPTV Test' });
  assert.match(svg, /СТАРТ ПЛЕЙ-ОФФ/);
  assert.match(svg, /28 июня/);
  assert.match(svg, /1\/16 финала/);
});

test('champion SVG renders the winner summary', () => {
  const model = {
    headline: 'Чемпионат мира 2026 · завершён',
    updated: '20 июл 2026',
    champion: { team: 'Франция', runnerUp: 'Бразилия', champScore: 2, runnerScore: 1, date: '19 июл' },
    fixtures: [],
  };
  const svg = buildWorldCupSlideSvg(model, { brand_name: 'IPTV Test' });
  assert.match(svg, /ЧЕМПИОН МИРА 2026/);
  assert.match(svg, /Франция/);
  assert.match(svg, /Финал: Франция 2 – 1 Бразилия/);
});

test('getWorldCupModel builds the slide model even with no API token (skeleton)', async () => {
  const savedToken = config.footballApi.token;
  config.footballApi.token = '';
  try {
    const model = await getWorldCupModel({ now: new Date('2026-06-28T12:00:00Z') });
    assert.ok(model.headline);
    assert.ok(Array.isArray(model.fixtures));
  } finally {
    config.footballApi.token = savedToken;
  }
});

test('getWorldCupSummary is gated by the enabled flag; getWorldCupModel is not', async () => {
  const savedToken = config.footballApi.token;
  const savedEnabled = config.worldcupSlide.enabled;
  config.footballApi.token = '';
  try {
    config.worldcupSlide.enabled = false;
    assert.equal(await getWorldCupSummary({ now: new Date('2026-06-28T12:00:00Z') }), null);
    // The admin preview path still resolves a model while the slide is off.
    assert.ok((await getWorldCupModel({ now: new Date('2026-06-28T12:00:00Z') })).headline);
    config.worldcupSlide.enabled = true;
    const model = await getWorldCupSummary({ now: new Date('2026-06-28T12:00:00Z') });
    assert.ok(model && model.headline);
  } finally {
    config.footballApi.token = savedToken;
    config.worldcupSlide.enabled = savedEnabled;
  }
});
