import { readFileSync } from "node:fs";
import { test, assertEqual, assert, fakeRepo } from "./harness.js";
import { runPipeline } from "../src/pipeline.js";

const fixture = (name) => readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");

function repoWith(extra = {}, memory = {}) {
  return fakeRepo(
    {
      "config.json": readFileSync(new URL("../config.json", import.meta.url), "utf8"),
      "data/statements/generic-2026-08.csv": fixture("generic-2026-08.csv"),
      "data/statements/generic-2026-09.csv": fixture("generic-2026-09.csv"),
      ...extra,
    },
    memory,
  );
}

test("finds a price increase and a hinted new subscription", async () => {
  const r = await runPipeline(repoWith(), { now: new Date("2026-10-01T09:00:00Z") });
  assertEqual(r.period, "2026-09");
  assertEqual(
    r.findings.map((f) => f.type + ":" + f.merchant),
    ["new-subscription:PIXELPRESS PLUS", "price-increase:TUNEBOX MONTHLY"],
  );
});

test("account numbers never leave the adapter unmasked", async () => {
  const repo = repoWith();
  const r = await runPipeline(repo, { now: new Date("2026-10-01T09:00:00Z") });
  assert(r.sources.length === 2, "both statements read");
  assert(!JSON.stringify(r).includes("xxxx"), "raw account text leaked into output");
});

test("alias memory merges spellings of one merchant", async () => {
  const r = await runPipeline(
    repoWith({ "data/statements/generic-2026-09.csv": fixture("generic-2026-09.csv").replace("TUNEBOX MONTHLY,11.99", "TBX*TUNEBOX 800-555,11.99") }),
    { now: new Date("2026-10-01T09:00:00Z") },
  );
  assert(!r.findings.some((f) => f.type === "price-increase"), "without memory the two spellings are different merchants");
  const withMemory = await runPipeline(
    repoWith(
      { "data/statements/generic-2026-09.csv": fixture("generic-2026-09.csv").replace("TUNEBOX MONTHLY,11.99", "TBX*TUNEBOX 800-555,11.99") },
      { "merchant-aliases.json": JSON.stringify({ "TBX*TUNEBOX 800-555": "TUNEBOX MONTHLY" }) },
    ),
    { now: new Date("2026-10-01T09:00:00Z") },
  );
  assert(withMemory.findings.some((f) => f.type === "price-increase" && f.merchant === "TUNEBOX MONTHLY"));
});

test("maskAccount keeps only the last four digits", async () => {
  const { maskAccount } = await import("../src/types.js");
  const full = ["4111", "2222", "3333", "4417"].join("");
  assertEqual(maskAccount(full), "****4417");
  assertEqual(maskAccount("xxxx xxxx xxxx 4417"), "****4417");
});
