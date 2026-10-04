// Thin helpers over the Artifacts binding: names, tokens, reads.
//
// Reads go through the binding (cheap, no clone). Writes never do -- there is
// no write API -- they go through a WorkingCopy with a token minted here.

import type { Env } from "../env.ts";
import type { Remote } from "../git/ops.ts";

export const SEED_REPOS = ["rules", "memory", "experience"] as const;
export const TEMPLATE_PREFIX = "tpl-";

/** A workspace fork handed to an outside agent: `<app>.ws-<agent>-<id>`. */
export function workspaceName(app: string, agent: string, id: string): string {
  return app + ".ws-" + agent.replace(/[^A-Za-z0-9_-]/g, "-") + "-" + id;
}

export function parseWorkspace(name: string): { app: string; agent: string } | null {
  const m = name.match(/^(.+)\.ws-(.+)-([A-Za-z0-9]{4,12})$/);
  return m ? { app: m[1], agent: m[2] } : null;
}

export async function withRepo<T>(env: Env, name: string, fn: (r: ArtifactsRepo) => Promise<T>): Promise<T> {
  const repo = await env.ARTIFACTS.get(name);
  try {
    return await fn(repo);
  } finally {
    try {
      (repo as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    } catch {
      /* already released */
    }
  }
}

export async function exists(env: Env, name: string): Promise<boolean> {
  try {
    await withRepo(env, name, (r) => r.info());
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "NOT_FOUND") return false;
    // Still forking or importing: it exists, it just is not ready.
    if (code && code.endsWith("_IN_PROGRESS")) return true;
    throw e;
  }
}

/** Mint a short-lived token and return a Remote a WorkingCopy can use. */
export async function remoteFor(
  env: Env,
  name: string,
  scope: "read" | "write",
  ttlSeconds: number,
): Promise<Remote & { tokenId: string; expiresAt: string }> {
  return withRepo(env, name, async (r) => {
    const [info, tok] = await Promise.all([r.info(), r.createToken(scope, Math.max(60, ttlSeconds))]);
    return { url: info.remote, token: tok.plaintext, tokenId: tok.id, expiresAt: tok.expiresAt };
  });
}

export async function revoke(env: Env, name: string, tokenId: string): Promise<void> {
  try {
    await withRepo(env, name, (r) => r.revokeToken(tokenId));
  } catch {
    /* expired or the repo is gone: either way the token no longer works */
  }
}

/** The commit a branch, tag or sha points at, or null. */
export async function headOf(env: Env, name: string, ref = "main"): Promise<string | null> {
  return withRepo(env, name, async (r) => {
    const log = await r.log({ ref, limit: 1 });
    return log.length ? log[0].hash : null;
  });
}

export async function readText(env: Env, name: string, ref: string, path: string): Promise<string | null> {
  return withRepo(env, name, async (r) => {
    const blob = await r.readFile({ ref, path });
    return blob ? await blob.text() : null;
  });
}

/**
 * Every file under `prefixes` at commit `sha`, as text. This is how an app's
 * modules are read for the Dynamic Worker loader: tree walk through the binding,
 * no clone, and the result is cached by sha because a sha never changes.
 */
export async function readTreeFiles(
  env: Env,
  name: string,
  sha: string,
  accept: (path: string) => boolean,
): Promise<Record<string, string>> {
  return withRepo(env, name, async (r) => {
    const commit = await r.readCommit(sha);
    if (!commit) throw new Error("no commit " + sha + " in " + name);
    const out: Record<string, string> = {};
    const walk = async (treeHash: string, prefix: string) => {
      const entries = await r.readTree(treeHash);
      if (!entries) return;
      await Promise.all(
        entries.map(async (e) => {
          const path = prefix + e.name;
          if (e.type === "tree") return walk(e.hash, path + "/");
          if ((e.type === "blob" || e.type === "exec") && accept(path)) {
            const blob = await r.readBlob(e.hash);
            if (blob) out[path] = await blob.text();
          }
        }),
      );
    };
    await walk(commit.treeHash, "");
    return out;
  });
}

/** Wait for a freshly forked or created repo to become usable. */
export async function waitReady(env: Env, name: string, timeoutMs = 60000): Promise<number> {
  const started = Date.now();
  for (;;) {
    try {
      await withRepo(env, name, (r) => r.info());
      return Date.now() - started;
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      if (!code.endsWith("_IN_PROGRESS") || Date.now() - started > timeoutMs) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export async function listRepos(env: Env): Promise<{ name: string; description: string | null }[]> {
  const out: { name: string; description: string | null }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARTIFACTS.list({ limit: 200, cursor });
    for (const r of page.repos) out.push({ name: r.name, description: r.description });
    cursor = page.cursor;
  } while (cursor);
  return out;
}
