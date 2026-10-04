// Statement adapters. Agent path: agents add one adapter per format they meet.
// The template ships a generic adapter for "date,description,amount" exports.

import { parseCsv } from "../csv.js";
import { maskAccount } from "../types.js";

export const generic = {
  name: "generic-csv",
  detect(path, text) {
    if (!path.endsWith(".csv")) return false;
    const head = String(text).split(/\r?\n/, 1)[0].toLowerCase();
    return head.includes("date") && head.includes("description") && head.includes("amount");
  },
  parse(text, { path, config }) {
    const { rows } = parseCsv(text);
    return rows.map((r) => ({
      date: r.date,
      amount: Number(r.amount),
      currency: (r.currency || config.currency || "CAD").toUpperCase(),
      merchant: r.description,
      account: maskAccount(r.account || r.card || ""),
      source: path,
    }));
  },
};

export const adapters = [generic];

export function pickAdapter(path, text, config) {
  return adapters.find((a) => a.detect(path, text, config)) || null;
}
