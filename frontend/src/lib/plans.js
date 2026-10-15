// Shared plan presentation helpers. A plan is the channel package, so anywhere
// a plan is named we also say how much it grants.

export const periodSuffix = (p) => (p === 'month' ? '/мес.' : p === 'year' ? '/год' : '');

// Simultaneous-device cap as a short label. 0 (or missing) = no limit.
export const devicesLabel = (n) => (n > 0 ? `до ${n} устр. одновременно` : 'устройств без ограничений');

export const planLabel = (plan) => `${plan.name} (${plan.price}${periodSuffix(plan.billing_period)})`;

// The expiry date one plan period from today, as YYYY-MM-DD — what a new
// customer's subscription runs to if they pay on the day they are created.
// The server does the same arithmetic for a recorded payment (addPeriod in
// core/util.js); this is only the suggestion in the create form, and the admin
// can always overwrite it. A plan with no billing period is treated as monthly.
export function expiryForPlan(plan, today = new Date()) {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const day = date.getDate();
  if (plan?.billing_period === 'year') date.setFullYear(date.getFullYear() + 1);
  else date.setMonth(date.getMonth() + 1);
  // setMonth rolls 31 янв + 1 мес into March; step back to the last valid day.
  if (date.getDate() !== day) date.setDate(0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Add whole days, months or years to a YYYY-MM-DD date. Month arithmetic
// clamps to the last day of a shorter month (31 янв + 1 мес = 28 фев), like
// add_period in src/core/util.rs.
export function addPeriod(ymd, period, count) {
  const [y, m, d] = ymd.split('-').map(Number);
  let date;
  if (period === 'day') {
    date = new Date(y, m - 1, d + count);
  } else {
    const months = period === 'year' ? count * 12 : count;
    const last = new Date(y, m - 1 + months + 1, 0).getDate();
    date = new Date(y, m - 1 + months, Math.min(d, last));
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The expiry a payment will produce — a preview of payment_expiry in
// src/http/admin.rs: paid time stacks on what is left; a lapsed or open-ended
// account, or "from today", restarts from today.
export function paymentExpiry(expiresAt, { count, period, from }, today = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const current = expiresAt || '';
  const base = from === 'today' || !current || current < now ? now : current;
  return addPeriod(base, period, count);
}

export const prettyDate = (ymd) => (ymd
  ? new Date(`${ymd}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
  : '—');

// Options for a plan <Select>. The category count is part of the label because
// picking a plan blind is exactly how you hand a customer an empty playlist.
export function planOptions(plans) {
  return plans.map((plan) => {
    const count = plan.category_ids?.length ?? 0;
    return {
      value: plan.id,
      label: `${planLabel(plan)} — ${count ? `${count} кат.` : 'без категорий'}`,
    };
  });
}

// "Paid for N ..." — the units the payment endpoint understands.
export const PERIOD_UNITS = [
  { value: 'month', label: 'мес.' },
  { value: 'year', label: 'год' },
  { value: 'day', label: 'дн.' },
];

export const periodWord = (period, count = 1) => {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  const few = n1 >= 2 && n1 <= 4 && (n < 10 || n >= 20);
  const one = n1 === 1 && n !== 11;
  if (period === 'year') return one ? 'год' : few ? 'года' : 'лет';
  if (period === 'day') return one ? 'день' : few ? 'дня' : 'дней';
  return one ? 'месяц' : few ? 'месяца' : 'месяцев';
};

// The default amount of a payment: the plan's price for the periods paid,
// converted between month and year (mirrors suggestedPaymentCents in
// src/http/admin.rs). null = no fair price (days).
export function suggestedPaymentCents(plan, { count, period }) {
  if (!plan || !Number.isFinite(plan.price_cents)) return null;
  const billed = ['day', 'month', 'year'].includes(plan.billing_period) ? plan.billing_period : 'month';
  if (period === billed) return plan.price_cents * count;
  if (billed === 'month' && period === 'year') return plan.price_cents * 12 * count;
  if (billed === 'year' && period === 'month') return Math.round((plan.price_cents * count) / 12);
  return null;
}

export const euros = (cents) => (cents === null || cents === undefined
  ? '—'
  : `${(cents / 100).toLocaleString('ru-RU', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })} €`);
