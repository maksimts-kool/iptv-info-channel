import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanAudience, audienceIsEmpty, audienceMatches, audienceMembers,
} from '../../src/core/audience.js';

test('an audience is cleaned to unique customer ids and plan ids', () => {
  assert.equal(cleanAudience(null), null);
  assert.equal(cleanAudience('everyone'), null);
  assert.equal(cleanAudience([1, 2]), null);
  assert.deepEqual(cleanAudience({}), { users: [], plans: [] });
  assert.deepEqual(
    cleanAudience({ users: [3, '3', '7', -1, 2.5, 'x', null], plans: [' pro ', 'pro', '', 'x'.repeat(65)] }),
    { users: [3, 7], plans: ['pro'] },
  );
});

test('a customer belongs by id or by their current plan', () => {
  const alice = { id: 1, plan_id: 'pro' };
  const bob = { id: 2, plan_id: 'std' };
  const group = { users: [2], plans: ['pro'] };
  assert.equal(audienceMatches(group, alice), true);
  assert.equal(audienceMatches(group, bob), true);
  assert.equal(audienceMatches({ users: [], plans: ['vip'] }, bob), false);
  assert.equal(audienceMatches(null, bob), true, 'no audience = no restriction');
  assert.equal(audienceMatches(group, null), false, 'the general public is in no group');
  assert.equal(audienceIsEmpty({ users: [], plans: [] }), true);
  assert.equal(audienceIsEmpty(group), false);
  assert.deepEqual(audienceMembers({ users: [], plans: ['std'] }, [alice, bob]), [bob]);
});
