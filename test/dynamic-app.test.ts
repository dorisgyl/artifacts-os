// The app contract, exercised in a real workerd: the template is loaded with
// the Worker Loader exactly as src/apps/host.ts loads it -- modules keyed by
// repository path, `cloudflare:workers` imported from inside, no network, and a
// REPO capability passed through ctx.exports with props.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const tplDir = fileURLToPath(new URL("../templates/tpl-scheduled-scan/", import.meta.url));

function walk(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else out[relative(dir, p).split(sep).join("/")] = readFileSync(p, "utf8");
    }
  };
  visit(dir);
  return out;
}

const files = walk(tplDir);
files["data/statements/generic-2026-08.csv"] = files["tests/fixtures/generic-2026-08.csv"];
files["data/statements/generic-2026-09.csv"] = files["tests/fixtures/generic-2026-09.csv"];

const harness = `
import { WorkerEntrypoint } from "cloudflare:workers";
const FILES = ${JSON.stringify(files)};
const STAGED = new Map();

export class RepoCapability extends WorkerEntrypoint {
  async readFile(path) {
    const s = STAGED.get(this.ctx.props.runId + "/" + path);
    if (s !== undefined) return s;
    const view = { ...FILES, ...(this.ctx.props.overlay || {}) };
    return path in view ? view[path] : null;
  }
  async list(dir) { return Object.keys({ ...FILES, ...(this.ctx.props.overlay || {}) }).filter((p) => p.startsWith(dir)).sort(); }
  async memory(path) { return path === "merchant-aliases.json" ? "{}" : null; }
  async writeSnapshot(name, value) { STAGED.set(this.ctx.props.runId + "/snapshots/" + name, JSON.stringify(value)); }
  async log() {}
}

function load(env, ctx, props) {
  const view = { ...FILES, ...(props.overlay || {}) };
  return env.LOADER.get("app:" + props.runId, () => {
    const modules = {};
    for (const [p, t] of Object.entries(view)) if (p.startsWith("src/") && p.endsWith(".js")) modules[p] = t;
    return {
      compatibilityDate: "2026-10-01",
      mainModule: JSON.parse(view["app.json"]).main,
      modules,
      env: { REPO: ctx.exports.RepoCapability({ props }) },
      globalOutbound: null,
    };
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const props = { runId: url.searchParams.get("run") || "r1" };
    if (url.searchParams.get("overlay")) {
      // What an "enrich" strategy would have to do somewhere in the run.
      props.overlay = { "src/main.js": FILES["src/main.js"].replace("const repo = openRepo(this.env);\\n    const now", "await fetch('https://merchants.example/api');\\n    const repo = openRepo(this.env);\\n    const now") };
    }
    const stub = load(env, ctx, props);
    try {
      if (url.pathname === "/run") return Response.json(await stub.getEntrypoint().run({ now: "2026-10-01T09:00:00Z", mode: "smoke" }));
      return stub.getEntrypoint().fetch(new Request("http://app/"));
    } catch (e) {
      return Response.json({ error: String(e.message || e) }, { status: 500 });
    }
  },
};
`;

async function startDev(): Promise<{ url: string; stop: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "aos-dyn-"));
  writeFileSync(join(dir, "index.js"), harness);
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({ name: "aos-dyn", main: "index.js", compatibility_date: "2026-10-01", worker_loaders: [{ binding: "LOADER" }] }),
  );
  const port = 8800 + Math.floor(Math.random() * 100);
  const bin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: dir, stdio: "ignore" });
  const url = "http://127.0.0.1:" + port;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await fetch(url + "/ping");
      return { url, stop: () => child.kill() };
    } catch {
      /* not up yet */
    }
  }
  child.kill();
  throw new Error("wrangler dev did not start");
}

test("the template runs as a Dynamic Worker with no network", { timeout: 120000 }, async () => {
  const dev = await startDev();
  try {
    const run = (await (await fetch(dev.url + "/run?run=r1")).json()) as { ok: boolean; summary: string; findings: number };
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.equal(run.findings, 2);
    assert.match(run.summary, /1 new subscription\(s\), 1 price increase\(s\) in 2026-09/);

    // The page reads the snapshot the same run handed back.
    const page = await (await fetch(dev.url + "/page?run=r1")).text();
    assert.match(page, /PIXELPRESS PLUS/);
    assert.match(page, /TUNEBOX MONTHLY/);

    // An agent's code that calls out fails inside the sandbox.
    const bad = await fetch(dev.url + "/run?run=r2&overlay=1");
    const body = (await bad.json()) as { error?: string };
    assert.equal(bad.status, 500);
    assert.match(body.error || "", /not permitted to access the internet/);
  } finally {
    dev.stop();
  }
});
