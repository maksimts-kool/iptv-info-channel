// An AUDIENCE: a hand-picked group of customers, named by customer id and/or by
// plan. Shared by the two features that address only some customers — private
// media-channel articles/sections (src/media/) and the email newsletter
// (src/notify/) — so "who is in the group" means the same thing in both.
//
// Shape: { users: [userId, …], plans: [planId, …] }. A customer belongs when
// their id is listed OR their current plan is, so a plan-wide group follows the
// customer when their plan changes. An audience with neither list is a group
// of nobody (not "everyone": "everyone" is the absence of an audience).
//
// Pure — no I/O — and unit-tested (test/core/audience.test.js).

const MAX_MEMBERS = 500;

// Anything -> a clean audience, or null when the value is not an object at all
// (callers use null for "no restriction"). Ids are de-duplicated; users are
// positive integers, plans non-empty strings, both capped.
export function cleanAudience(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const users = [...new Set((Array.isArray(raw.users) ? raw.users : [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))].slice(0, MAX_MEMBERS);
  const plans = [...new Set((Array.isArray(raw.plans) ? raw.plans : [])
    .map((id) => String(id ?? '').trim())
    .filter((id) => id && id.length <= 64))].slice(0, MAX_MEMBERS);
  return { users, plans };
}

export function audienceIsEmpty(audience) {
  return !audience || (!audience.users?.length && !audience.plans?.length);
}

// Does this customer belong to the audience? `null` audience = no restriction.
// A missing customer (the "general public" viewer) belongs to no audience.
export function audienceMatches(audience, user) {
  if (!audience) return true;
  if (!user) return false;
  return (audience.users || []).includes(Number(user.id))
    || (audience.plans || []).includes(user.plan_id);
}

// Every customer the audience covers, in the order given.
export function audienceMembers(audience, users = []) {
  return users.filter((u) => audienceMatches(audience, u));
}
