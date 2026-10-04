// Finding new subscriptions and price increases. Agent path.
//
// The template's rules are deliberately plain:
//   - a merchant is subscription-like when its name carries a hint from
//     config.subscriptionHints, or when it has charged the same amount in at
//     least two earlier months;
//   - it is a "new subscription" when it is subscription-like and first appears
//     after the earliest month with data (so it was absent before);
//   - it is a "price increase" when it is subscription-like and its latest
//     charge is above the previous month's by more than
//     config.priceIncreaseThreshold.

import { monthOf } from "./types.js";

export function detect(transactions, { config = {} } = {}) {
  const threshold = config.priceIncreaseThreshold ?? 0.005;
  const hints = (config.subscriptionHints || []).map((h) => h.toLowerCase());
  const months = [...new Set(transactions.map((t) => monthOf(t.date)))].sort();
  const earliest = months[0];
  const latest = months[months.length - 1];

  const byMerchant = new Map();
  for (const t of transactions) {
    if (t.amount <= 0) continue;
    const list = byMerchant.get(t.canonical) || [];
    list.push(t);
    byMerchant.set(t.canonical, list);
  }

  const findings = [];
  for (const [merchant, list] of byMerchant) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list[list.length - 1];
    if (monthOf(last.date) !== latest) continue;

    const earlier = list.filter((t) => monthOf(t.date) !== latest);
    const hinted = hints.some((h) => merchant.toLowerCase().includes(h));
    const steady =
      earlier.length >= 2 && earlier.every((t) => Math.abs(t.amount - earlier[0].amount) < 0.005);
    if (!hinted && !steady) continue;

    const first = monthOf(list[0].date);
    if (first !== earliest) {
      findings.push({ type: "new-subscription", merchant, amount: last.amount, currency: last.currency, month: latest, since: first });
      continue;
    }
    const prev = earlier[earlier.length - 1];
    if (prev && last.amount > prev.amount * (1 + threshold)) {
      findings.push({ type: "price-increase", merchant, amount: last.amount, previous: prev.amount, currency: last.currency, month: latest });
    }
  }
  return findings.sort((a, b) => a.type.localeCompare(b.type) || a.merchant.localeCompare(b.merchant));
}
