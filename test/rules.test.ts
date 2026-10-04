import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { review, globMatch, findCardNumbers, branchRole } from "../src/rules/check.ts";

const rules = JSON.parse(readFileSync(new URL("../seeds/rules/rules.json", import.meta.url), "utf8"));
const app = JSON.parse(readFileSync(new URL("../templates/tpl-scheduled-scan/app.json", import.meta.url), "utf8"));

test("globs", () => {
  assert.ok(globMatch("src/adapters/**", "src/adapters/maple.js"));
  assert.ok(globMatch("src/adapters/**", "src/adapters/x/y.js"));
  assert.ok(globMatch("tests/*.test.js", "tests/maple.test.js"));
  assert.ok(!globMatch("tests/*.test.js", "tests/fixtures/a.test.js"));
  assert.ok(!globMatch("src/normalize.js", "src/normalize.jsx"));
});

test("the enrich strategy is rejected for calling out", () => {
  const r = review({
    repo: "card-watch",
    branch: "attempt/enrich",
    rules,
    app,
    changed: [
      {
        path: "src/normalize.js",
        type: "modify",
        content: "export async function lookup(d) {\n  const r = await fetch('https://merchants.example/api?q=' + d);\n  return r.json();\n}\n",
      },
    ],
  });
  assert.equal(r.verdict, "reject");
  assert.equal(r.findings[0].rule, "no-egress");
  assert.equal(r.findings[0].line, 2);
});

test("a fuzzy strategy inside agent paths passes", () => {
  const r = review({
    repo: "card-watch",
    branch: "attempt/fuzzy",
    rules,
    app,
    changed: [
      { path: "src/normalize.js", type: "modify", content: "// see https://example.com for the idea\nexport function normalize(t) { return t; }\n" },
      { path: "tests/normalize.test.js", type: "add", content: "import { test } from './harness.js';\nimport { readFileSync } from 'node:fs';\n" },
    ],
  });
  assert.equal(r.verdict, "pass", JSON.stringify(r.findings));
});

test("template code from an agent branch is sent to the template", () => {
  const r = review({
    repo: "card-watch",
    branch: "agent/input",
    rules,
    app,
    changed: [{ path: "src/csv.js", type: "modify", content: "export const x = 1;\n" }],
  });
  assert.equal(r.verdict, "reject");
  assert.match(r.findings[0].detail, /template repository/);
  // ...while the same change on a template fix branch is fine
  const t = review({ repo: "tpl-scheduled-scan", branch: "fix/csv-quoted-comma", rules, app, changed: r.findings.map(() => ({ path: "src/csv.js", type: "modify" as const, content: "export const x = 1;\n" })) });
  assert.equal(t.verdict, "pass");
});

test("full card numbers are found, masked ones are not", () => {
  const full = ["4111", "1111", "1111", "1111"].join("");
  assert.equal(findCardNumbers("a," + full + ",b").length, 1);
  assert.equal(findCardNumbers("****1111 and xxxx xxxx xxxx 1111").length, 0);
  assert.equal(findCardNumbers("order 1234567890123").length, 0); // not Luhn-valid
});

test("dependencies are refused", () => {
  const r = review({
    repo: "card-watch",
    branch: "agent/analysis",
    rules,
    app,
    changed: [{ path: "src/detect.js", type: "modify", content: "import dayjs from 'dayjs';\n" }],
  });
  assert.equal(r.verdict, "reject");
  assert.equal(r.findings[0].rule, "no-deps");
});

test("branch roles", () => {
  assert.equal(branchRole("tpl-scheduled-scan", "fix/x"), "template-fix");
  assert.equal(branchRole("card-watch", "upgrade/tpl-v1.1"), "upgrade");
  assert.equal(branchRole("card-watch", "ext/claude-code/northwind"), "agent");
  assert.equal(branchRole("card-watch", "main"), "owner");
});
