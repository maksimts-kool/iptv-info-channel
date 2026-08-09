// Shared plan presentation helpers. A plan is the channel package, so anywhere
// a plan is named we also say how much it grants.

export const periodSuffix = (p) => (p === 'month' ? '/мес.' : p === 'year' ? '/год' : '');

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
