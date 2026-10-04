// The report body. Agent path.

import { esc } from "./report-shell.js";

const money = (n, c) => (c ? c + " " : "") + Number(n).toFixed(2);

export function renderReport(r) {
  const rows = r.findings
    .map(
      (f) => `<tr>
  <td><span class="tag ${f.type === "new-subscription" ? "new" : "up"}">${f.type === "new-subscription" ? "new" : "price up"}</span></td>
  <td>${esc(f.merchant)}</td>
  <td>${money(f.amount, f.currency)}</td>
  <td class="muted">${f.previous !== undefined ? "was " + money(f.previous) : "since " + esc(f.since || f.month)}</td>
</tr>`,
    )
    .join("");
  const skipped = r.skipped && r.skipped.length
    ? `<p class="muted">Skipped: ${r.skipped.map((s) => esc(s.path.split("/").pop()) + " (" + esc(s.reason) + ")").join(", ")}</p>`
    : "";
  return `<p class="muted">${esc(r.summary)} · ${r.transactions} transactions from ${r.sources.length} statement(s) · generated ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC</p>
${rows ? `<table><thead><tr><th></th><th>Merchant</th><th>Amount</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : "<p>Nothing new this month.</p>"}
${skipped}`;
}
