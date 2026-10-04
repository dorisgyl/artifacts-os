import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLanes } from "../src/control/planner.ts";
import { nextRun } from "../src/lib/cron.ts";

test("the template declares its own lanes", () => {
  const lanes = parseLanes(readFileSync(new URL("../templates/tpl-scheduled-scan/AGENTS.md", import.meta.url), "utf8"));
  assert.deepEqual(lanes.map((l) => l.name), ["input", "analysis"]);
  assert.match(lanes[0].text, /src\/adapters/);
  assert.match(lanes[1].text, /detect\.js/);
});

test("cron: the first of the month at 09:00 UTC", () => {
  const next = nextRun("0 9 1 * *", Date.parse("2026-10-04T12:00:00Z"));
  assert.equal(new Date(next).toISOString(), "2026-11-01T09:00:00.000Z");
  assert.equal(new Date(nextRun("17 * * * *", Date.parse("2026-10-04T12:20:00Z"))).toISOString(), "2026-10-04T13:17:00.000Z");
  assert.equal(new Date(nextRun("*/15 * * * *", Date.parse("2026-10-04T12:20:00Z"))).toISOString(), "2026-10-04T12:30:00.000Z");
});
