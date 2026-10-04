// The memory repository: what the agent has learned about its owner.
//
// Writes go straight to main -- remembering is additive, and asking the owner
// to approve every alias would make a personal agent a chore. What makes that
// safe is that it is Git: every memory write is one commit the Console lists,
// and "forget that" is a revert, not a database edit.

import type { Env } from "../env.ts";
import { coordinator, registry } from "../env.ts";
import { WorkingCopy, RUNTIME } from "../git/ops.ts";
import { completeJson } from "../agents/llm.ts";
import { withRepo } from "../lib/artifacts.ts";

const ALIASES = "merchant-aliases.json";

async function memoryRemote(env: Env) {
  return (await coordinator(env, "memory").issue("memory", "runtime", [{ repo: "memory", scope: "write" }], 300)).memory;
}

/** After a merge that touched normalisation, ask which descriptors were unified. */
export async function learnFromMerge(env: Env, repo: string, wc: WorkingCopy, before: string, after: string) {
  const changed = await wc.changed(before, after);
  const relevant = changed.filter((c) => /src\/(normalize\.js|adapters\/)/.test(c.path));
  if (!relevant.length) return null;

  const code: string[] = [];
  for (const c of relevant) {
    const text = await wc.readAt(after, c.path);
    if (text) code.push("// " + c.path + "\n" + text.slice(0, 6000));
  }
  const statements: string[] = [];
  for (const p of await wc.files()) {
    if (p.startsWith("data/statements/") && (p.endsWith(".csv") || p.endsWith(".md"))) {
      statements.push("// " + p + "\n" + ((await wc.read(p)) || "").split("\n").slice(0, 40).join("\n"));
    }
  }
  const { value } = await completeJson<{ aliases: Record<string, string> }>(env, [
    {
      role: "system",
      content:
        'Extract merchant aliases the new code unifies. Reply {"aliases": {"<descriptor as printed>": "<canonical name>"}}. ' +
        "Only descriptors that appear in the statements. No card numbers. Empty object if none.",
    },
    { role: "user", content: code.join("\n\n") + "\n\nStatements:\n" + statements.join("\n\n") },
  ]);
  const learned = Object.entries(value.aliases || {}).filter(([k, v]) => k && v && k !== v && !/\d{12,}/.test(k));
  if (!learned.length) return null;

  const remote = await memoryRemote(env);
  const mem = await WorkingCopy.clone(remote, { ref: "main" });
  const current = JSON.parse((await mem.read(ALIASES)) || "{}") as Record<string, string>;
  const fresh = learned.filter(([k]) => !(k in current));
  if (!fresh.length) return null;
  for (const [k, v] of fresh) current[k] = v;
  await mem.write(ALIASES, JSON.stringify(current, null, 2) + "\n");
  const oid = await mem.commit(
    "Remember " + fresh.length + " merchant alias" + (fresh.length > 1 ? "es" : "") + " from " + repo,
    RUNTIME,
  );
  await mem.push(remote, "main");
  await registry(env).publish({
    at: Date.now(),
    repo: "memory",
    agent: "runtime",
    kind: "memory",
    status: "written",
    detail: fresh.map(([k, v]) => k + " → " + v).join(", "),
    data: { sha: oid, from: repo },
  });
  return oid;
}

export async function memoryLog(env: Env, limit = 20) {
  return withRepo(env, "memory", (r) => r.log({ ref: "main", limit }));
}

/** Undo one memory commit with a revert commit on top. */
export async function revertMemory(env: Env, sha: string): Promise<string> {
  const remote = await memoryRemote(env);
  const mem = await WorkingCopy.clone(remote, { ref: "main", full: true });
  const log = await mem.log("main", 200);
  const target = log.find((c) => c.oid === sha);
  if (!target) throw new Error("not a memory commit on main: " + sha);
  const parent = target.commit.parent[0];
  if (!parent) throw new Error("cannot revert the first commit");
  for (const c of await mem.changed(parent, sha)) {
    const old = await mem.readAt(parent, c.path);
    if (old === null) await mem.remove(c.path);
    else await mem.write(c.path, old);
  }
  const oid = await mem.commit('Revert "' + target.commit.message.trim() + '"', RUNTIME);
  await mem.push(remote, "main");
  await registry(env).publish({
    at: Date.now(),
    repo: "memory",
    agent: "owner",
    kind: "memory",
    status: "reverted",
    detail: target.commit.message.trim(),
    data: { sha: oid, reverted: sha },
  });
  return oid;
}
