// The Transaction shape every adapter produces. This is the boundary between
// the input lane and the analysis lane. Template code.

/**
 * @typedef {Object} Transaction
 * @property {string} date      ISO date, YYYY-MM-DD
 * @property {number} amount    positive for money spent
 * @property {string} currency  ISO 4217
 * @property {string} merchant  as printed on the statement
 * @property {string} account   last four digits only, as "****1234"
 * @property {string} source    repository path of the statement
 * @property {string} [canonical] normalised merchant name (set by normalize.js)
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MASKED = /^\*{4}\d{4}$/;

export function checkTransaction(t) {
  const problems = [];
  if (!t || typeof t !== "object") return ["not an object"];
  if (!DATE.test(t.date || "")) problems.push("date must be YYYY-MM-DD: " + t.date);
  if (typeof t.amount !== "number" || !Number.isFinite(t.amount)) problems.push("amount must be a number");
  if (!/^[A-Z]{3}$/.test(t.currency || "")) problems.push("currency must be ISO 4217");
  if (!t.merchant) problems.push("merchant is required");
  if (!MASKED.test(t.account || "")) problems.push("account must be masked as ****1234");
  if (!t.source) problems.push("source is required");
  return problems;
}

export function maskAccount(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return "****" + digits.slice(-4).padStart(4, "0");
}

export function monthOf(date) {
  return String(date).slice(0, 7);
}
