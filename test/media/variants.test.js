import test from 'node:test';
import assert from 'node:assert/strict';
import {
  articlesFor, variantKey, mediaVariants, hasPrivateContent,
} from '../../src/media/variants.js';

const t = (text) => ({ type: 'text', text });
const p = (text) => ({ type: 'paragraph', content: [t(text)] });
const doc = (...content) => ({ type: 'doc', content });
const priv = (audience, ...content) => ({ type: 'privateSection', attrs: { audience }, content });

const alice = { id: 1, plan_id: 'pro' };
const bob = { id: 2, plan_id: 'std' };
const carol = { id: 3, plan_id: 'std' };

const articles = [
  { id: 'news', doc: doc(p('всем')), audience: null },
  { id: 'vip', doc: doc(p('только про')), audience: { users: [], plans: ['pro'] } },
  { id: 'mixed', doc: doc(p('общая часть'), priv({ users: [2], plans: [] }, p('для Боба'))), audience: null },
  { id: 'empty-for-public', doc: doc(priv({ users: [3], plans: [] }, p('для Кэрол'))), audience: null },
];

test('each viewer sees public articles, their private ones, and their sections', () => {
  const ids = (viewer) => articlesFor(articles, viewer).map((e) => (e.mask ? `${e.article.id}:${e.mask}` : e.article.id));
  assert.deepEqual(ids(null), ['news', 'mixed:0'], 'an article with nothing public in it is left out');
  assert.deepEqual(ids(alice), ['news', 'vip', 'mixed:0']);
  assert.deepEqual(ids(bob), ['news', 'mixed:1']);
  assert.deepEqual(ids(carol), ['news', 'mixed:0', 'empty-for-public:1']);
  assert.equal(articlesFor(articles, 'all').length, 4, 'the admin preview sees everything');
  const bobs = articlesFor(articles, bob)[1].article.doc;
  assert.ok(JSON.stringify(bobs).includes('для Боба'));
  assert.ok(!JSON.stringify(bobs).includes('privateSection'), 'the renderer only ever gets a plain document');
});

test('customers who see the same thing share one variant; the public one always exists', () => {
  const dave = { id: 4, plan_id: 'free' };
  const { publicKey, variants } = mediaVariants(articles, [alice, bob, carol, dave]);
  assert.equal(variants.size, 4);
  assert.deepEqual(variants.get(publicKey).userIds, [4], 'dave sees only public content');
  assert.equal(variants.get(publicKey).public, true);
  assert.deepEqual(variants.get(variantKey(articlesFor(articles, alice))).userIds, [1]);
  // Nothing private at all: everybody is on the public loop.
  const plain = [articles[0]];
  assert.equal(hasPrivateContent(plain), false);
  assert.equal(hasPrivateContent(articles), true);
  assert.equal(mediaVariants(plain, [alice, bob]).variants.size, 1);
});
