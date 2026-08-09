// Shared plan presentation helpers. A plan is the channel package, so anywhere
// a plan is named we also say how much it grants.

export const periodSuffix = (p) => (p === 'month' ? '/мес.' : p === 'year' ? '/год' : '');

export const planLabel = (plan) => `${plan.name} (${plan.price}${periodSuffix(plan.billing_period)})`;

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
