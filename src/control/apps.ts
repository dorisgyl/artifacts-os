// Owner actions on an app: upload a statement, run now, ask for a change, and
// the hourly schedule. Each is a thin layer over Git and the workflows.

import type { Env } from "../env.ts";
import { coordinator, registry } from "../env.ts";
import { commitToMain, runApp } from "../apps/host.ts";
import { planChange } from "./planner.ts";
import { readText, workflowId } from "../lib/artifacts.ts";

const SAFE = /^[A-Za-z0-9._-]{1,80}$/;

/** Statements are committed to the app's own repository: data/statements/. */
export async function uploadStatements(env: Env, app: string, files: { name: string; bytes: Uint8Array; type: string }[]) {
  const out: Record<string, string | Uint8Array> = {};
  for (const f of files) {
    const name = f.name.replace(/[^A-Za-z0-9._-]/g, "_");
    if (!SAFE.test(name)) throw new Error("bad file name " + f.name);
    if (name.toLowerCase().endsWith(".pdf")) {
      // Apps read text. The original is committed next to its conversion, so
      // the owner can always see exactly what the app was given.
      const conv = (await env.AI.toMarkdown({ name, blob: new Blob([f.bytes], { type: "application/pdf" }) })) as {
        format: string;
        data?: string;
        error?: string;
      };
      if (conv.format === "error" || !conv.data) throw new Error("could not convert " + name + ": " + (conv.error || "no text"));
      out["data/statements/" + name] = f.bytes;
      out["data/statements/" + name.replace(/\.pdf$/i, ".md")] = conv.data;
    } else {
      out["data/statements/" + name] = new TextDecoder().decode(f.bytes);
    }
  }
  const message = "Upload " + files.map((f) => f.name).join(", ");
  const oid = await commitToMain(env, app, out, message);
  await registry(env).publish({ at: Date.now(), repo: app, agent: "owner", kind: "upload", status: "committed", detail: message, data: { sha: oid } });
  return { sha: oid, files: Object.keys(out) };
}

export async function runNow(env: Env, exports: unknown, app: string) {
  const r = await runApp(env, exports, app, { mode: "live" });
  await registry(env).publish({
    at: Date.now(),
    repo: app,
    agent: "app",
    kind: "run",
    status: "done",
    detail: r.result.summary || "",
    data: { committed: r.committed },
  });
  return r;
}

/** Hourly: every app whose own schedule says it is due runs at main. */
export async function runDue(env: Env, exports: unknown) {
  const due = await registry(env).due(Date.now());
  const results: Record<string, string> = {};
  for (const a of due) {
    try {
      const r = await runApp(env, exports, a.name, { mode: "live" });
      results[a.name] = r.result.summary || "ok";
    } catch (e) {
      results[a.name] = "failed: " + String((e as Error).message || e);
      await registry(env).markRun(a.name, Date.now(), results[a.name]);
    }
  }
  return results;
}

/**
 * A change request in the owner's words. The planner decides between a
 * playbook (competing attempts), one agent, or a template fix, and the lanes
 * start at once.
 */
export async function requestChange(env: Env, app: string, request: string) {
  const latest = await readText(env, app, "main", "snapshots/latest.json");
  let context = "";
  if (latest) {
    try {
      const s = JSON.parse(latest);
      context = "Last run: " + s.summary + (s.skipped && s.skipped.length ? "\nSkipped: " + JSON.stringify(s.skipped) : "");
    } catch {
      /* no usable snapshot */
    }
  }
  const plan = await planChange(env, app, request, context);
  const lanesRepo = plan.lanes[0]?.repo || app;
  const coord = coordinator(env, lanesRepo);
  await registry(env).publish({
    at: Date.now(),
    repo: app,
    agent: "planner",
    kind: "plan",
    status: plan.kind,
    detail: plan.kind === "playbook" ? "playbook " + plan.playbook!.id + ": " + plan.lanes.length + " attempts" : plan.kind,
    data: plan.decision,
  });
  const ids: string[] = [];
  for (const [i, l] of plan.lanes.entries()) {
    await coord.startLane(l.repo, { agent: l.agent, kind: "edge", branch: l.branch, strategy: l.strategy ? l.strategy.summary : l.task.slice(0, 200) });
    // Staggered a little so later agents read earlier agents' claims.
    if (i) await new Promise((r) => setTimeout(r, 2000));
    const inst = await env.AGENT_RUN.create({
      id: workflowId(l.repo, l.agent),
      params: {
        repo: l.repo,
        agent: l.agent,
        branch: l.branch,
        task: l.task,
        allowed: l.allowed,
        strategy: l.strategy,
        target: l.target,
        origin: l.origin,
        extraContext: context || undefined,
      },
    });
    ids.push(inst.id);
  }
  return { plan: { kind: plan.kind, decision: plan.decision, lanes: plan.lanes.map((l) => ({ repo: l.repo, agent: l.agent, branch: l.branch })) }, instances: ids };
}
