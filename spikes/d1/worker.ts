// D1 verification: the platform facts the design depends on, checked against
// a real account before anything is built on them. Each endpoint answers one
// item of the D1 list with PASS/FAIL and the numbers it saw.
//
// Deploy:  npm run d1:deploy
//          npx wrangler secret put D1_KEY -c spikes/d1/wrangler.jsonc
// Run:     npm run d1 -- https://artifacts-os-d1.<you>.workers.dev
// Then delete it: it uses its own namespace (artifacts-os-d1) and has no Access.

import { WorkerEntrypoint, WorkflowEntrypoint, DurableObject, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { WorkingCopy, RUNTIME, MergeConflict, hasConflictMarkers } from "../../src/git/ops.ts";
import { writeNotes, notesFor } from "../../src/git/notes.ts";
import { BUNDLE } from "../../src/generated/bundle.ts";

interface Env {
  ARTIFACTS: Artifacts;
  LOADER: WorkerLoader;
  AI: Ai;
  LOG: DurableObjectNamespace<EventLog>;
  D1_KEY?: string;
}

const TPL = "d1-tpl";

async function remote(env: Env, name: string, scope: "read" | "write" = "write") {
  const repo = await env.ARTIFACTS.get(name);
  const [info, tok] = await Promise.all([repo.info(), repo.createToken(scope, 900)]);
  return { url: info.remote, token: tok.plaintext };
}

async function ready(env: Env, name: string) {
  const t0 = Date.now();
  for (;;) {
    try {
      await (await env.ARTIFACTS.get(name)).info();
      return Date.now() - t0;
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      if (!code.endsWith("_IN_PROGRESS") || Date.now() - t0 > 120000) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function ensureTemplate(env: Env) {
  try {
    await (await env.ARTIFACTS.get(TPL)).info();
    return;
  } catch {
    /* create below */
  }
  const created = await env.ARTIFACTS.create(TPL, { description: "D1 template", setDefaultBranch: "main" });
  const wc = await WorkingCopy.init("main");
  for (const [p, c] of Object.entries(BUNDLE.templates["tpl-scheduled-scan"])) await wc.write(p, c);
  await wc.write("data/statements/generic-2026-08.csv", BUNDLE.templates["tpl-scheduled-scan"]["tests/fixtures/generic-2026-08.csv"]);
  await wc.write("data/statements/generic-2026-09.csv", BUNDLE.templates["tpl-scheduled-scan"]["tests/fixtures/generic-2026-09.csv"]);
  await wc.commit("D1 template", RUNTIME);
  await wc.push({ url: created.remote, token: created.token }, "main");
}

const stamp = () => Date.now().toString(36);

async function forkFresh(env: Env, prefix: string) {
  await ensureTemplate(env);
  const name = prefix + "-" + stamp();
  const t0 = Date.now();
  await (await env.ARTIFACTS.get(TPL)).fork(name, { defaultBranchOnly: false });
  const readyMs = await ready(env, name);
  return { name, forkMs: Date.now() - t0, readyMs };
}

// ---- item 1: isomorphic-git in a Worker, and fork timing -----------------
async function item1(env: Env) {
  const forks: number[] = [];
  let last = "";
  for (let i = 0; i < 10; i++) {
    const f = await forkFresh(env, "d1-fork");
    forks.push(f.forkMs);
    last = f.name;
  }
  const r = await remote(env, last);
  const t0 = Date.now();
  const wc = await WorkingCopy.clone(r, { ref: "main" });
  const cloneMs = Date.now() - t0;
  await wc.checkout("main", { create: "agent/d1" });
  await wc.write("src/normalize.js", "export function normalize(t) { return t; }\n// d1 " + stamp() + "\n");
  const oid = await wc.commit("D1 commit from a Worker", RUNTIME);
  const t1 = Date.now();
  await wc.push(r, "agent/d1");
  const pushMs = Date.now() - t1;
  const log = await (await env.ARTIFACTS.get(last)).log({ ref: "agent/d1", limit: 1 });
  const sorted = [...forks].sort((a, b) => a - b);
  return {
    pass: log[0]?.hash === oid,
    forkMs: { min: sorted[0], median: sorted[5], max: sorted[9] },
    cloneMs,
    pushMs,
    files: (await wc.files()).length,
  };
}

// ---- item 2: Dynamic Worker loads an app at a sha, with no network -------
export class Cap extends WorkerEntrypoint<Env, { repo: string; sha: string; runId: string }> {
  static staged = new Map<string, string>();
  async readFile(path: string) {
    const s = Cap.staged.get(this.ctx.props.runId + "/" + path);
    if (s !== undefined) return s;
    const blob = await (await this.env.ARTIFACTS.get(this.ctx.props.repo)).readFile({ ref: this.ctx.props.sha, path });
    return blob ? blob.text() : null;
  }
  async list(dir: string) {
    const files = await treeFiles(this.env, this.ctx.props.repo, this.ctx.props.sha);
    return Object.keys(files).filter((p) => p.startsWith(dir)).sort();
  }
  async memory() {
    return "{}";
  }
  async writeSnapshot(name: string, value: unknown) {
    Cap.staged.set(this.ctx.props.runId + "/snapshots/" + name, JSON.stringify(value));
  }
  async log() {}
}

async function treeFiles(env: Env, repo: string, sha: string) {
  const r = await env.ARTIFACTS.get(repo);
  const commit = await r.readCommit(sha);
  const out: Record<string, string> = {};
  const walk = async (h: string, prefix: string) => {
    for (const e of (await r.readTree(h)) || []) {
      if (e.type === "tree") await walk(e.hash, prefix + e.name + "/");
      else {
        const b = await r.readBlob(e.hash);
        if (b) out[prefix + e.name] = await b.text();
      }
    }
  };
  await walk(commit!.treeHash, "");
  return out;
}

async function item2(env: Env, ctx: ExecutionContext) {
  await ensureTemplate(env);
  const sha = (await (await env.ARTIFACTS.get(TPL)).log({ ref: "main", limit: 1 }))[0].hash;
  const t0 = Date.now();
  const files = await treeFiles(env, TPL, sha);
  const readMs = Date.now() - t0;
  const load = (runId: string, overlay: Record<string, string> = {}) =>
    env.LOADER.get(TPL + "@" + sha + ":" + runId, () => {
      const modules: Record<string, string> = {};
      for (const [p, t] of Object.entries({ ...files, ...overlay })) if (p.startsWith("src/") && p.endsWith(".js")) modules[p] = t;
      return {
        compatibilityDate: "2026-10-01",
        mainModule: "src/main.js",
        modules,
        env: { REPO: (ctx.exports as unknown as { Cap: (o: object) => Fetcher }).Cap({ props: { repo: TPL, sha, runId } }) },
        globalOutbound: null,
      };
    });
  const runId = "r" + stamp();
  type AppEP = { run(o: object): Promise<{ ok: boolean; summary: string }>; fetch(r: Request): Promise<Response> };
  const t1 = Date.now();
  const result = await (load(runId).getEntrypoint() as unknown as AppEP).run({ mode: "smoke" });
  const runMs = Date.now() - t1;
  const page = await (await (load(runId).getEntrypoint() as unknown as AppEP).fetch(new Request("http://app/"))).text();
  let network = "not blocked";
  try {
    const leaky = { "src/main.js": files["src/main.js"].replace("const repo = openRepo(this.env);\n    const now", "await fetch('https://example.com');\n    const repo = openRepo(this.env);\n    const now") };
    await (load(runId + "-net", leaky).getEntrypoint() as unknown as AppEP).run({});
  } catch (e) {
    network = String((e as Error).message || e).slice(0, 120);
  }
  return {
    pass: result.ok && /PIXELPRESS/.test(page) && network !== "not blocked",
    summary: result.summary,
    readMs,
    runMs,
    network,
  };
}

// ---- item 3: namespace-wide push events reach a Workflow -----------------
export class EventLog extends DurableObject<Env> {
  async add(e: unknown) {
    const list = ((await this.ctx.storage.get<unknown[]>("events")) || []).slice(-200);
    list.push({ at: Date.now(), e });
    await this.ctx.storage.put("events", list);
  }
  async all() {
    return (await this.ctx.storage.get<unknown[]>("events")) || [];
  }
}

export class OnPush extends WorkflowEntrypoint<Env, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep) {
    await step.do("record", async () => {
      await this.env.LOG.get(this.env.LOG.idFromName("log")).add(event.payload as never);
      return true;
    });
  }
}

async function item3start(env: Env) {
  const f = await forkFresh(env, "d1-events");
  const r = await remote(env, f.name);
  const wc = await WorkingCopy.clone(r, { ref: "main" });
  const head = await wc.resolve("main");
  await wc.checkout("main", { create: "agent/events" });
  await wc.write("x.txt", stamp());
  await wc.commit("D1 event probe", RUNTIME);
  await wc.push(r, "agent/events");
  await writeNotes(wc, r, [{ kind: "intent", writer: "d1", oid: head, body: { v: 1 } }], RUNTIME);
  return { repo: f.name, pushed: ["refs/heads/agent/events", "refs/notes/intent/d1"], checkAfter: "about 30 s: GET /d1/3/result?repo=" + f.name };
}

async function item3result(env: Env, repo: string) {
  const all = (await env.LOG.get(env.LOG.idFromName("log")).all()) as { e: { source?: { repoName?: string }; payload?: { ref?: string } } }[];
  const mine = all.filter((x) => JSON.stringify(x.e).includes(repo));
  const refs = mine.map((x) => x.e?.payload?.ref || JSON.stringify(x.e).slice(0, 200));
  return {
    pass: refs.some((r) => String(r).includes("agent/events")),
    newForkPushSeen: refs.some((r) => String(r).includes("agent/events")),
    notesPushSeen: refs.some((r) => String(r).includes("refs/notes/")),
    events: refs,
    sample: mine[0] ? mine[0].e : null,
  };
}

// ---- item 4: merge with conflict markers inside a Worker -----------------
async function item4(env: Env) {
  const f = await forkFresh(env, "d1-merge");
  const r = await remote(env, f.name);
  const a = await WorkingCopy.clone(r, { ref: "main", full: true });
  const base = await a.resolve("main");
  await a.write("src/csv.js", (await a.read("src/csv.js"))!.replace('delimiter = ","', 'delimiter = ";"'));
  await a.commit("Semicolon customisation", RUNTIME);
  await a.push(r, "main");
  const b = await WorkingCopy.clone(r, { ref: "main", full: true });
  await b.checkout(base, { create: "fix/csv" });
  await b.write("src/csv.js", (await b.read("src/csv.js"))!.replace('delimiter = ","', 'delimiter = ",", quote = \'"\''));
  const theirs = await b.commit("Quoted fields", RUNTIME);
  await b.push(r, "fix/csv");

  const c = await WorkingCopy.clone(r, { ref: "main", full: true });
  await c.fetchRef(r, "refs/heads/fix/csv", "refs/heads/fix/csv", { full: true });
  let conflicts: string[] = [];
  try {
    await c.merge("main", "fix/csv", "Merge fix", RUNTIME);
  } catch (e) {
    if (e instanceof MergeConflict) conflicts = e.files;
    else throw e;
  }
  const text = (await c.read("src/csv.js")) || "";
  const markers = hasConflictMarkers(text);
  await c.write("src/csv.js", text.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, "$2"));
  const merged = await c.commitMerge("main", theirs, "Merge fix (resolved)", RUNTIME);
  await c.push(r, "main");
  const parents = (await (await env.ARTIFACTS.get(f.name)).readCommit(merged))!.parents;
  return { pass: markers && conflicts.includes("src/csv.js") && parents.length === 2, conflicts, markers, parents: parents.length };
}

// ---- item 5: notes refs, fork, fetch -------------------------------------
async function item5(env: Env) {
  const f = await forkFresh(env, "d1-notes");
  const r = await remote(env, f.name);
  const wc = await WorkingCopy.clone(r, { ref: "main" });
  const head = await wc.resolve("main");
  await writeNotes(
    wc,
    r,
    [
      { kind: "intent", writer: "agent-a", oid: head, body: { v: 1, status: "claimed" } },
      { kind: "review", writer: "rules-auditor", oid: head, body: { v: 1, verdict: "pass" } },
    ],
    RUNTIME,
  );
  const reader = await WorkingCopy.clone(r, { ref: "main" });
  const refs = await reader.fetchNotes(r);
  const notes = await notesFor(reader, refs, head);

  // Does a fork carry notes refs? (defaultBranchOnly false and default)
  const childAll = f.name + "-c1";
  const childMain = f.name + "-c2";
  await (await env.ARTIFACTS.get(f.name)).fork(childAll, { defaultBranchOnly: false });
  await (await env.ARTIFACTS.get(f.name)).fork(childMain);
  await ready(env, childAll);
  await ready(env, childMain);
  const notesInAll = await reader.listRemoteRefs(await remote(env, childAll, "read"), "refs/notes/");
  const notesInMain = await reader.listRemoteRefs(await remote(env, childMain, "read"), "refs/notes/");
  // Can the binding read a notes ref by name? (would save a clone per read)
  let bindingReadsNotes = "no";
  try {
    const blob = await (await env.ARTIFACTS.get(f.name)).readFile({ ref: "refs/notes/intent/agent-a", path: head });
    bindingReadsNotes = blob ? "yes: " + (await blob.text()).slice(0, 60) : "no (null)";
  } catch (e) {
    bindingReadsNotes = "no: " + String((e as Error).message).slice(0, 80);
  }
  return {
    pass: notes.length === 2,
    notesRead: notes.length,
    forkWithAllBranchesCopiesNotes: notesInAll.length > 0,
    forkDefaultCopiesNotes: notesInMain.length > 0,
    bindingReadsNotes,
  };
}

// ---- item 6: fork write token + read-only parent -------------------------
async function item6(env: Env) {
  const parent = await forkFresh(env, "d1-parent");
  const ws = parent.name + ".ws-claude-code-ab12";
  await (await env.ARTIFACTS.get(parent.name)).fork(ws);
  await ready(env, ws);
  const wsWrite = await remote(env, ws, "write");
  const parentRead = await remote(env, parent.name, "read");
  const wc = await WorkingCopy.clone(parentRead, { ref: "main" });
  await wc.checkout("main", { create: "ext/try" });
  await wc.write("y.txt", stamp());
  await wc.commit("probe", RUNTIME);
  const attempt = async (rem: { url: string; token: string }) => {
    try {
      await wc.push(rem, "ext/try");
      return "accepted";
    } catch (e) {
      return "refused: " + String((e as Error).message).slice(0, 80);
    }
  };
  const toFork = await attempt(wsWrite);
  const toParentWithRead = await attempt(parentRead);
  const toParentWithForkToken = await attempt({ url: parentRead.url, token: wsWrite.token });
  return {
    pass: toFork === "accepted" && toParentWithRead.startsWith("refused") && toParentWithForkToken.startsWith("refused"),
    workspaceNameAccepted: ws,
    toFork,
    toParentWithRead,
    toParentWithForkToken,
  };
}

// ---- item 7: Jev returns probabilities ----------------------------------
async function item7(env: Env) {
  const t0 = Date.now();
  let raw: unknown;
  try {
    raw = await env.AI.run("typesafe/jev" as never, {
      state: { conflicts: ["src/csv.js"], gates: ["npm test"] },
      questions: {
        decision: {
          type: "choice",
          question: "Can this be finished at the edge, or does it need a container with a shell?",
          criteria: { edge: "only a textual overlap", container: "something must run (tests)" },
        },
      },
    } as never);
  } catch (e) {
    return { pass: false, error: String((e as Error).message || e) };
  }
  const a = (raw as { answers?: { decision?: { probabilities?: Record<string, number> } } })?.answers?.decision;
  return { pass: !!(a && a.probabilities), ms: Date.now() - t0, raw };
}

// ---- item 11: PDF -> markdown -------------------------------------------
async function item11(env: Env, req: Request) {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return { pass: false, error: "POST a PDF statement as the body" };
  const r = (await env.AI.toMarkdown({ name: "statement.pdf", blob: new Blob([bytes], { type: "application/pdf" }) })) as { format: string; data?: string };
  return { pass: r.format !== "error" && !!r.data, format: r.format, chars: (r.data || "").length, head: (r.data || "").slice(0, 600) };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (env.D1_KEY && req.headers.get("x-d1-key") !== env.D1_KEY) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const run = async (fn: () => Promise<unknown>) => {
      try {
        return Response.json(await fn());
      } catch (e) {
        const err = e as { message?: string; code?: string; stack?: string };
        return Response.json({ pass: false, error: err.message || String(e), code: err.code, stack: (err.stack || "").split("\n").slice(0, 4) }, { status: 500 });
      }
    };
    switch (url.pathname) {
      case "/d1/1": return run(() => item1(env));
      case "/d1/2": return run(() => item2(env, ctx));
      case "/d1/3": return run(() => item3start(env));
      case "/d1/3/result": return run(() => item3result(env, url.searchParams.get("repo") || ""));
      case "/d1/4": return run(() => item4(env));
      case "/d1/5": return run(() => item5(env));
      case "/d1/6": return run(() => item6(env));
      case "/d1/7": return run(() => item7(env));
      case "/d1/11": return run(() => item11(env, req));
      case "/d1/cleanup": return run(async () => {
        const gone: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.ARTIFACTS.list({ limit: 200, cursor });
          for (const r of page.repos) if (r.name.startsWith("d1-")) { await env.ARTIFACTS.delete(r.name); gone.push(r.name); }
          cursor = page.cursor;
        } while (cursor);
        return { deleted: gone.length };
      });
      default: return new Response("D1: /d1/1 /d1/2 /d1/3 (/d1/3/result?repo=) /d1/4 /d1/5 /d1/6 /d1/7 POST /d1/11 /d1/cleanup\n");
    }
  },
};
