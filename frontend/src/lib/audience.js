// A group of customers, as the server understands it (src/core/audience.js):
// { users: [id…], plans: [planId…] } — a customer belongs when listed by id or
// when on one of the plans. Used by private media and the newsletter.

export const EMPTY_AUDIENCE = { users: [], plans: [] };

export function audienceMatches(audience, user) {
  if (!audience) return true;
  if (!user) return false;
  return (audience.users || []).includes(user.id) || (audience.plans || []).includes(user.plan_id);
}

export function audienceMembers(audience, users = []) {
  return users.filter((u) => audienceMatches(audience, u));
}

export function audienceIsEmpty(audience) {
  return !audience || (!audience.users?.length && !audience.plans?.length);
}

// "Тариф «Про» и 2 клиента" — short, for tags and list rows.
export function audienceLabel(audience, users = [], plans = []) {
  if (!audience) return 'все клиенты';
  if (audienceIsEmpty(audience)) return 'никто (группа пуста)';
  const planNames = (audience.plans || [])
    .map((id) => plans.find((p) => p.id === id)?.name)
    .filter(Boolean)
    .map((n) => `«${n}»`);
  const names = (audience.users || [])
    .map((id) => users.find((u) => u.id === id)?.username)
    .filter(Boolean);
  const parts = [];
  if (planNames.length) parts.push(`${planNames.length === 1 ? 'тариф' : 'тарифы'} ${planNames.join(', ')}`);
  if (names.length) parts.push(names.length <= 2 ? names.join(', ') : `${names.length} ${clientsWord(names.length)}`);
  return parts.join(' и ') || 'никто (группа пуста)';
}

export function clientsWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'клиент';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'клиента';
  return 'клиентов';
}
