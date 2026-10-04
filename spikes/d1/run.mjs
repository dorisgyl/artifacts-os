#!/usr/bin/env node
// Runs D1 items 1-7 (and 11 with a PDF) against the deployed D1 worker and
// prints one line per item. Results are written to spikes/d1/results.json.
//
//   npm run d1 -- https://artifacts-os-d1.<you>.workers.dev [path/to/statement.pdf]
//   D1_KEY=... must match the secret set on the worker.

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const base = (process.argv[2] || "").replace(/\/$/, "");
const pdf = process.argv[3];
if (!base) {
  console.error("usage: npm run d1 -- <d1 worker url> [statement.pdf]");
  process.exit(2);
}
const headers = process.env.D1_KEY ? { "x-d1-key": process.env.D1_KEY } : {};
const get = async (path, init = {}) => {
  const t0 = Date.now();
  const res = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const body = await res.json().catch(async () => ({ pass: false, error: await res.text() }));
  return { ...body, httpMs: Date.now() - t0 };
};

const NAMES = {
  1: "isomorphic-git clone/commit/push in a Worker; fork timing",
  2: "Dynamic Worker loads an app at a sha; no network",
  3: "namespace-wide push events reach a Workflow",
  4: "merge leaves conflict markers; two-parent commit",
  5: "notes: write, push, fetch; do forks copy them",
  6: "fork write token + read-only parent",
  7: "Jev choice returns probabilities",
  11: "PDF statement -> markdown",
};

const results = {};
const line = (n, r) => console.log((r.pass ? "PASS " : "FAIL ") + String(n).padStart(2) + "  " + NAMES[n] + "\n       " + JSON.stringify({ ...r, raw: undefined, sample: undefined, stack: undefined }).slice(0, 400));

for (const n of [1, 2, 4, 5, 6, 7]) {
  results[n] = await get("/d1/" + n);
  line(n, results[n]);
}
const started = await get("/d1/3");
console.log("     3  pushed to " + started.repo + "; waiting 45 s for events...");
await new Promise((r) => setTimeout(r, 45000));
results[3] = await get("/d1/3/result?repo=" + encodeURIComponent(started.repo || ""));
line(3, results[3]);
if (pdf && existsSync(pdf)) {
  results[11] = await get("/d1/11", { method: "POST", body: readFileSync(pdf), headers: { "content-type": "application/pdf" } });
  line(11, results[11]);
} else {
  console.log("SKIP 11  pass a PDF statement path as the second argument");
}
console.log("\nManual: 8 (container push to a fork), 9 (Access on /apps/*), 10 (deploy button on a fresh account), 12 (model stability) -- see CLAUDE.md.");
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), base, results }, null, 2));
