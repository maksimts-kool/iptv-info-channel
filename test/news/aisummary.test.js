import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySummaries, cleanSummary, summaryMessages, textHash, OPENROUTER_URL,
} from '../../src/news/aisummary.js';

const NOTICE = {
  id: '8786',
  published_at: '2026-09-14T10:06:44.000Z',
  kind: 'maintenance',
  headline: 'Технические работы',
  body: 'Сообщаем, что часть телеканалов будет временно недоступна.',
  text: 'Технические работы! Сообщаем, что часть телеканалов будет временно недоступна в течение нескольких часов. Приносим извинения.',
};

function stubAi(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = answers.shift();
    if (next instanceof Response) return next;
    return new Response(JSON.stringify({ choices: [{ message: { content: next } }] }), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('cleanSummary strips markdown, lead-ins, quotes and clips on a word', () => {
  assert.equal(cleanSummary('**Кратко:** «Часть каналов недоступна до 18:00.»'), 'Часть каналов недоступна до 18:00.');
  assert.equal(cleanSummary('<think>hmm</think>\n\nАрхив недоступен ⚠️\n\nВторой абзац'), 'Архив недоступен');
  const long = cleanSummary('слово '.repeat(60), 40);
  assert.ok(long.length <= 40 && long.endsWith('…'), long);
  assert.equal(cleanSummary('   '), '');
});

test('the prompt carries the headline and the full original text', () => {
  const [system, user] = summaryMessages(NOTICE);
  assert.equal(system.role, 'system');
  assert.match(user.content, /Заголовок: Технические работы/);
  assert.match(user.content, /в течение нескольких часов/);
});

test('the model is asked only for new or changed text', async () => {
  const { fetchImpl, calls } = stubAi(['Часть каналов недоступна несколько часов.', 'Архив недоступен до вечера.']);
  const options = { apiKey: 'sk-test', model: 'openrouter/free', fetchImpl };

  const first = await applySummaries([NOTICE], {}, options);
  assert.equal(first.error, null);
  assert.equal(first.notices[0].body, 'Часть каналов недоступна несколько часов.');
  assert.equal(first.notices[0].ai, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OPENROUTER_URL);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].body.model, 'openrouter/free');
  assert.deepEqual(first.cache, { 8786: { hash: textHash(NOTICE.text), summary: 'Часть каналов недоступна несколько часов.' } });

  // Same text again: served from the cache, no request.
  const again = await applySummaries([NOTICE], first.cache, options);
  assert.equal(calls.length, 1);
  assert.equal(again.notices[0].body, 'Часть каналов недоступна несколько часов.');

  // The provider edited the notice: asked again.
  const edited = await applySummaries([{ ...NOTICE, text: `${NOTICE.text} Архив тоже.` }], again.cache, options);
  assert.equal(calls.length, 2);
  assert.equal(edited.notices[0].body, 'Архив недоступен до вечера.');

  // A notice gone from the feed drops out of the cache.
  assert.deepEqual((await applySummaries([], edited.cache, options)).cache, {});
});

test('a failed call keeps the parser body and is not cached', async () => {
  const { fetchImpl } = stubAi([
    new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429 }),
  ]);
  const out = await applySummaries([NOTICE], {}, { apiKey: 'sk-test', fetchImpl });
  assert.match(out.error, /Rate limit/);
  assert.equal(out.notices[0].body, NOTICE.body);
  assert.equal(out.notices[0].ai, undefined);
  assert.deepEqual(out.cache, {});
});

test('without a key nothing is sent and the notices are untouched', async () => {
  const { fetchImpl, calls } = stubAi([]);
  const out = await applySummaries([NOTICE], { 8786: { hash: 'x', summary: 'y' } }, { apiKey: '', fetchImpl });
  assert.equal(calls.length, 0);
  assert.deepEqual(out.notices, [NOTICE]);
});
