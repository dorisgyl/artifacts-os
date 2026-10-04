// RepoCapability: the one door a personal app has.
//
// The runtime loads an app as a Dynamic Worker with `globalOutbound: null` --
// no network at all -- and passes this entrypoint in its env as REPO, bound by
// props to one repository at one commit. Through it the app can read its own
// files, read the owner's memory, and hand results back. It cannot write Git,
// cannot see another repository, and never sees a token.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { coordinator, registry } from "../env.ts";
import { readTreeFiles, readText } from "../lib/artifacts.ts";
import type { Json } from "../lib/json.ts";

export interface CapabilityProps {
  repo: string;
  sha: string;
  /** live: results are committed. preview/smoke: results are only shown. */
  mode: "live" | "preview" | "smoke";
  runId?: string;
  /** Files an agent has written but not yet pushed (smoke tests). */
  overlay?: Record<string, string>;
}

const TREE_CACHE = new Map<string, Record<string, string>>();
const TREE_CACHE_MAX = 32;

export async function filesAt(env: Env, repo: string, sha: string): Promise<Record<string, string>> {
  const key = repo + "@" + sha;
  const hit = TREE_CACHE.get(key);
  if (hit) return hit;
  // Text files only: a PDF original is kept next to its .md conversion and
  // apps read the conversion.
  const files = await readTreeFiles(env, repo, sha, (p) => !/\.(pdf|png|jpe?g|gif|zip)$/i.test(p));
  TREE_CACHE.set(key, files);
  if (TREE_CACHE.size > TREE_CACHE_MAX) TREE_CACHE.delete(TREE_CACHE.keys().next().value as string);
  return files;
}

export class RepoCapability extends WorkerEntrypoint<Env, CapabilityProps> {
  private async view(): Promise<Record<string, string>> {
    const p = this.ctx.props;
    const base = await filesAt(this.env, p.repo, p.sha);
    return p.overlay ? { ...base, ...p.overlay } : base;
  }

  async readFile(path: string): Promise<string | null> {
    const p = this.ctx.props;
    // A run's own snapshots are visible to the same run's page, so a preview
    // can show the report it just produced without committing it.
    if (p.runId && path.startsWith("snapshots/")) {
      const staged = await coordinator(this.env, p.repo).staged(p.runId);
      const name = path.slice("snapshots/".length);
      if (name in staged) return JSON.stringify(staged[name]);
    }
    const files = await this.view();
    return path in files ? files[path] : null;
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir.endsWith("/") || dir === "" ? dir : dir + "/";
    return Object.keys(await this.view())
      .filter((p) => p.startsWith(prefix))
      .sort();
  }

  async memory(path: string): Promise<string | null> {
    if (path.includes("..")) return null;
    return readText(this.env, "memory", "main", path);
  }

  async writeSnapshot(name: string, value: Json): Promise<void> {
    const p = this.ctx.props;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("snapshot names are plain file names");
    if (!p.runId) throw new Error("this invocation cannot write snapshots");
    await coordinator(this.env, p.repo).stage(p.runId, name, value);
  }

  async log(event: { kind?: string; detail?: string }): Promise<void> {
    const p = this.ctx.props;
    await registry(this.env).publish({
      at: Date.now(),
      repo: p.repo,
      agent: "app",
      kind: "app-" + (event.kind || "log"),
      status: p.mode,
      detail: String(event.detail || "").slice(0, 300),
    });
  }
}
