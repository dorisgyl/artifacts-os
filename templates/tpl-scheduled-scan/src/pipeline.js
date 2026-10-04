// import -> parse -> normalise -> detect. Template code: the order and the
// contract between stages are fixed here; what each stage does lives in agent
// paths (adapters/, normalize.js, detect.js, report.js).

import { pickAdapter } from "./adapters/index.js";
import { normalize } from "./normalize.js";
import { detect } from "./detect.js";
import { checkTransaction, monthOf } from "./types.js";

export async function runPipeline(repo, { now = new Date(), mode = "manual" } = {}) {
  const config = (await repo.readJson("config.json")) || {};
  const aliases = (await repo.memoryJson("merchant-aliases.json")) || {};
  const paths = (await repo.list("data/statements/")).filter(
    (p) => !p.endsWith("README.md") && !p.endsWith(".pdf"),
  );

  const transactions = [];
  const sources = [];
  const skipped = [];
  for (const path of paths) {
    const text = await repo.readFile(path);
    if (text === null) continue;
    const adapter = pickAdapter(path, text, config);
    if (!adapter) {
      skipped.push({ path, reason: "no adapter recognises this format" });
      continue;
    }
    const parsed = adapter.parse(text, { path, config });
    const bad = [];
    for (const t of parsed) {
      const problems = checkTransaction(t);
      if (problems.length) bad.push(problems[0]);
      else transactions.push(t);
    }
    sources.push({ path, adapter: adapter.name, transactions: parsed.length - bad.length, rejected: bad.length });
    if (bad.length) skipped.push({ path, reason: bad.length + " rows rejected: " + bad[0] });
  }

  const normalized = normalize(transactions, { aliases, config });
  const findings = detect(normalized, { now, config });
  const months = [...new Set(normalized.map((t) => monthOf(t.date)))].sort();
  const period = months.length ? months[months.length - 1] : null;
  const counts = findings.reduce((m, f) => ((m[f.type] = (m[f.type] || 0) + 1), m), {});

  return {
    period,
    mode,
    generatedAt: now.toISOString(),
    months,
    sources,
    skipped,
    transactions: normalized.length,
    findings,
    summary:
      (counts["new-subscription"] || 0) + " new subscription(s), " +
      (counts["price-increase"] || 0) + " price increase(s) in " + (period || "no data"),
  };
}
