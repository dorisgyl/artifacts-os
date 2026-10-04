// Merging from the approval bar.
//
// The owner's click is the decision; the runtime does the Git work with a
// short-lived write token, writes the owner's choice as a decision note on the
// merge commit, and moves the losing attempts under archive/ with an outcome
// note, because what was not chosen and why is what agents learn from.

import type { Env } from "../env.ts";
import { coordinator, registry } from "../env.ts";
import { WorkingCopy, RUNTIME, OWNER_VIA_RUNTIME, MergeConflict } from "../git/ops.ts";
import { writeNotes, type NoteWrite } from "../git/notes.ts";
import { learnFromMerge } from "../control/memory.ts";

export interface MergeResult {
  ok: boolean;
  merged?: string;
  archived?: string[];
  tag?: string;
  fanOut?: string;
  conflict?: string[];
  error?: string;
}

function nextVersion(current: string): string {
  const m = current.match(/^v(\d+)\.(\d+)$/);
  return m ? "v" + m[1] + "." + (Number(m[2]) + 1) : "v1.1";
}

export async function mergeBranch(
  env: Env,
  ctx: ExecutionContext,
  repo: string,
  branch: string,
  reason: string,
): Promise<MergeResult> {
  const coord = coordinator(env, repo);
  const remote = (await coord.issue(repo, "runtime", [{ repo, scope: "write" }], 600))[repo];
  const wc = await WorkingCopy.clone(remote, { ref: "main", full: true });
  const mainBefore = await wc.resolve("main");
  const theirs = await wc.fetchRef(remote, "refs/heads/" + branch, "refs/heads/" + branch, { full: true });
  if (!theirs) return { ok: false, error: "no such branch " + branch };

  let merged: string;
  try {
    merged = await wc.merge("main", branch, "Merge " + branch, OWNER_VIA_RUNTIME);
  } catch (e) {
    if (e instanceof MergeConflict) return { ok: false, conflict: e.files, error: "conflicts with main" };
    throw e;
  }
  await coord.expectMain(repo, merged);
  await wc.push(remote, "main");
  await registry(env).setMain(repo, merged);

  const lane = await coord.laneByBranch(branch);
  const notes: NoteWrite[] = [
    {
      kind: "decision",
      writer: "owner",
      oid: merged,
      body: { v: 1, by: "owner", decision: "merge " + branch, reason: reason || "", to: "all" },
    },
    {
      kind: "outcome",
      writer: "owner",
      oid: theirs,
      body: { v: 1, source: "owner", outcome: "merged", detail: reason || "chosen in the approval bar" },
    },
  ];

  // The other attempts at the same request lose, and are kept.
  const archived: string[] = [];
  const group = branch.startsWith("attempt/") ? "attempt/" : null;
  if (group) {
    for (const other of await coord.lanes()) {
      if (!other.branch || other.branch === branch || !other.branch.startsWith(group)) continue;
      if (["merged", "archived"].includes(other.status)) continue;
      const oid = await wc.fetchRef(remote, "refs/heads/" + other.branch, "refs/heads/archive/" + other.branch);
      if (!oid) continue;
      await wc.push(remote, "refs/heads/archive/" + other.branch);
      await wc.deleteRemoteRef(remote, "refs/heads/" + other.branch);
      notes.push({
        kind: "outcome",
        writer: "owner",
        oid,
        body: {
          v: 1,
          source: "owner",
          outcome: "archived",
          detail: other.status === "blocked" ? "blocked by rules review" : "not chosen; " + branch + " was merged",
        },
      });
      archived.push(other.branch);
      await coord.laneEvent(other.agent, "archived", "moved to archive/" + other.branch);
    }
  }
  await writeNotes(wc, remote, notes, RUNTIME);
  if (lane) await coord.laneEvent(lane.agent, "merged", reason || undefined, { head: merged });

  const result: MergeResult = { ok: true, merged, archived };

  // A merged template fix becomes a new template version and fans out.
  if (repo.startsWith("tpl-") && branch.startsWith("fix/")) {
    const manifest = JSON.parse((await wc.read("app.json")) || "{}");
    const current = (manifest.template && manifest.template.version) || "v1.0";
    const tag = nextVersion(current);
    manifest.template = { ...(manifest.template || {}), repo, version: tag };
    await wc.write("app.json", JSON.stringify(manifest, null, 2) + "\n");
    const bumped = await wc.commit("Release " + tag, RUNTIME);
    await coord.expectMain(repo, bumped);
    await wc.push(remote, "main");
    await wc.tag(tag, bumped);
    await wc.push(remote, "refs/tags/" + tag);
    const inst = await env.FAN_OUT.create({ params: { template: repo, tag, fixBranch: branch } });
    result.tag = tag;
    result.fanOut = inst.id;
  }

  // Merges that taught the agent something about the owner's merchants are
  // remembered; this never blocks the merge.
  ctx.waitUntil(
    learnFromMerge(env, repo, wc, mainBefore, merged).catch((e) =>
      coord.note("memory", "could not learn from merge: " + String((e as Error).message || e)),
    ),
  );
  return result;
}
