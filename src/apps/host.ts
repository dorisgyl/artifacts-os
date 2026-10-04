// Serving and running personal apps as Dynamic Workers.
//
// An app is whatever its repository says at one commit. The runtime reads the
// modules through the Artifacts binding, loads them with the Worker Loader
// under the id `<repo>@<sha>:<mode>`, and gives them no network and one
// capability. So every branch is live the moment it is pushed: a preview is
// just the same loader call with a different sha.

import type { Env } from "../env.ts";
import { coordinator, registry } from "../env.ts";
import { filesAt, type CapabilityProps } from "./capability.ts";
import { headOf } from "../lib/artifacts.ts";
import { WorkingCopy, RUNTIME } from "../git/ops.ts";
import { approvalBar } from "./approval-bar.ts";

export const APP_COMPAT_DATE = "2026-10-01";

type Exports = { RepoCapability: (o: { props: CapabilityProps }) => Fetcher };

export function urlRef(segment: string): string {
  // Branch names carry slashes; in a URL path segment they are written as "~".
  return decodeURIComponent(segment).replace(/~/g, "/");
}

export function refSegment(branch: string): string {
  return branch.replace(/\//g, "~");
}

async function hashText(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadApp(
  env: Env,
  exports: unknown,
  props: CapabilityProps,
  files?: Record<string, string>,
): Promise<WorkerStub> {
  const view = files || (await filesAt(env, props.repo, props.sha));
  const merged = props.overlay ? { ...view, ...props.overlay } : view;
  const overlayTag = props.overlay ? ":" + (await hashText(JSON.stringify(props.overlay))) : "";
  const id = props.repo + "@" + props.sha + ":" + props.mode + ":" + (props.runId || "-") + overlayTag;
  return env.LOADER.get(id, async () => {
    let manifest: { main?: string } = {};
    try {
      manifest = JSON.parse(merged["app.json"] || "{}");
    } catch {
      /* a broken manifest still loads src/main.js */
    }
    const modules: Record<string, string> = {};
    for (const [path, text] of Object.entries(merged)) {
      if (path.startsWith("src/") && path.endsWith(".js")) modules[path] = text;
    }
    return {
      compatibilityDate: APP_COMPAT_DATE,
      mainModule: manifest.main || "src/main.js",
      modules,
      env: { REPO: (exports as Exports).RepoCapability({ props }) },
      // No network. Personal data does not leave, whatever the code says.
      globalOutbound: null,
      limits: { cpuMs: 30000, subRequests: 100 },
    };
  });
}

type AppEntrypoint = {
  run(opts: { now?: string; mode?: string }): Promise<{ ok: boolean; period?: string; summary?: string; findings?: number }>;
  fetch(r: Request): Promise<Response>;
};

function entry(stub: WorkerStub): AppEntrypoint {
  return stub.getEntrypoint() as unknown as AppEntrypoint;
}

/** Run an app's pipeline. Live runs commit their snapshots to main. */
export async function runApp(
  env: Env,
  exports: unknown,
  repo: string,
  opts: { sha?: string; mode: "live" | "preview" | "smoke"; overlay?: Record<string, string>; now?: string },
) {
  const sha = opts.sha || (await headOf(env, repo, "main"));
  if (!sha) throw new Error(repo + " has no main branch yet");
  const runId = opts.mode + "-" + crypto.randomUUID();
  const stub = await loadApp(env, exports, { repo, sha, mode: opts.mode, runId, overlay: opts.overlay });
  const result = await entry(stub).run({ now: opts.now, mode: opts.mode === "live" ? "scheduled" : opts.mode });
  const snapshots = await coordinator(env, repo).staged(runId);
  let committed: string | null = null;
  if (opts.mode === "live" && Object.keys(snapshots).length) {
    committed = await commitSnapshots(env, repo, snapshots, result.summary || "run");
  }
  if (opts.mode === "live") {
    await registry(env).markRun(repo, Date.now(), result.summary || null);
  }
  return { sha, runId, result, snapshots, committed };
}

/** Commit files to main as the runtime, with the main guard told first. */
export async function commitToMain(
  env: Env,
  repo: string,
  files: Record<string, string | Uint8Array>,
  message: string,
): Promise<string> {
  const remotes = await coordinator(env, repo).issue(repo, "runtime", [{ repo, scope: "write" }], 300);
  const remote = remotes[repo];
  for (let attempt = 0; attempt < 3; attempt++) {
    const wc = await WorkingCopy.clone(remote, { ref: "main" });
    for (const [path, content] of Object.entries(files)) await wc.write(path, content);
    const oid = await wc.commit(message, RUNTIME);
    await coordinator(env, repo).expectMain(repo, oid);
    try {
      await wc.push(remote, "main");
      await registry(env).setMain(repo, oid);
      return oid;
    } catch (e) {
      if (attempt === 2) throw e; // main moved under us three times running
    }
  }
  throw new Error("unreachable");
}

async function commitSnapshots(env: Env, repo: string, snapshots: Record<string, unknown>, summary: string) {
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries(snapshots)) {
    files["snapshots/" + name] = JSON.stringify(value, null, 2) + "\n";
  }
  return commitToMain(env, repo, files, "Run: " + summary);
}

/**
 * GET /apps/<repo>/...           -> the live app at main
 * GET /apps/<repo>/@<ref>/...    -> a preview at a branch or sha, with the
 *                                   approval bar on top
 */
export async function serveApp(env: Env, exports: unknown, request: Request, rest: string[]): Promise<Response> {
  const [repo, maybeRef, ...tail] = rest;
  if (!repo) return new Response("no app\n", { status: 404 });
  const preview = maybeRef && maybeRef.startsWith("@");
  const ref = preview ? urlRef(maybeRef.slice(1)) : "main";
  const path = "/" + (preview ? tail : [maybeRef, ...tail].filter(Boolean)).join("/");

  const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : await headOf(env, repo, ref);
  if (!sha) return new Response("no such branch: " + ref + "\n", { status: 404 });

  const url = new URL(request.url);
  const inner = new Request(new URL(path + url.search, url.origin), { method: request.method, headers: request.headers });

  if (!preview) {
    const stub = await loadApp(env, exports, { repo, sha, mode: "live" });
    return entry(stub).fetch(inner);
  }

  // A preview runs the pipeline on the same statements, shows the result and
  // commits nothing. The run id is per sha, so reloading reuses the result.
  const runId = "preview-" + sha.slice(0, 16);
  const staged = await coordinator(env, repo).staged(runId);
  let runError: string | null = null;
  if (!Object.keys(staged).length) {
    try {
      const stub = await loadApp(env, exports, { repo, sha, mode: "preview", runId });
      await entry(stub).run({ mode: "preview" });
    } catch (e) {
      runError = String((e as Error).message || e);
    }
  }
  const stub = await loadApp(env, exports, { repo, sha, mode: "preview", runId });
  const page = await entry(stub).fetch(inner);
  if (!(page.headers.get("content-type") || "").includes("text/html")) return page;
  const bar = await approvalBar(env, repo, ref, sha, runError);
  return new HTMLRewriter()
    .on("body", {
      element(el) {
        el.prepend(bar, { html: true });
      },
    })
    .transform(page);
}
