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
  warnings?: string[];
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
  expectedSha?: string,
): Promise<MergeResult> {
  const coord = coordinator(env, repo);
  const lane = await coord.laneByBranch(branch);

  // Only what was reviewed is merged: the lane's last verdict must be a pass,
  // for exactly the commit the owner looked at.
  const review = lane && (lane.review as { verdict?: string } | null);
  if (!lane || !review || review.verdict !== "pass") return { ok: false, error: "this branch has not passed review" };
  if (expectedSha && lane.head !== expectedSha) return { ok: false, error: "the branch moved since this version was reviewed" };
  if (["merged", "archived"].includes(lane.status)) return { ok: false, error: "already " + lane.status };

  const remote = (await coord.issue(repo, "runtime", [{ repo, scope: "write" }], 600))[repo];
  const wc = await WorkingCopy.clone(remote, { ref: "main", full: true });
  const mainBefore = await wc.resolve("main");
  const theirs = await wc.fetchRef(remote, "refs/heads/" + branch, "refs/heads/" + branch, { full: true });
  if (!theirs) return { ok: false, error: "no such branch " + branch };
  if (theirs !== lane.head) return { ok: false, error: "the branch moved since it was reviewed; wait for the new review" };

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
  await coord.laneEvent(lane.agent, "merged", reason || undefined, { head: theirs });

  // From here on main has moved: bookkeeping failures are reported, never thrown.
  const warnings: string[] = [];
  const notes: NoteWrite[] = [
    { kind: "decision", writer: "owner", oid: merged, body: { v: 1, by: "owner", decision: "merge " + branch, reason: reason || "", to: "all" } },
    { kind: "outcome", writer: "owner", oid: theirs, body: { v: 1, source: "owner", outcome: "merged", detail: reason || "chosen in the approval bar" } },
  ];

  // The other attempts at the same request lose, and are kept.
  const archived: string[] = [];
  if (branch.startsWith("attempt/")) {
    for (const other of await coord.lanes()) {
      if (!other.branch || other.branch === branch || !other.branch.startsWith("attempt/")) continue;
      if (["merged", "archived"].includes(other.status)) continue;
      try {
        const oid = await wc.fetchRef(remote, "refs/heads/" + other.branch, "refs/heads/archive/" + other.branch).catch(() => null);
        if (oid) {
          const target = "refs/heads/archive/" + other.branch + "-" + oid.slice(0, 7);
          await wc.fetchRef(remote, "refs/heads/" + other.branch, target);
          await wc.push(remote, target, { force: true });
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
        }
        archived.push(other.branch);
        await coord.laneEvent(other.agent, "archived", oid ? "kept as " + "archive/" + other.branch : "never pushed");
      } catch (e) {
        warnings.push("could not archive " + other.branch + ": " + String((e as Error).message || e));
      }
    }
  }
  try {
    await writeNotes(wc, remote, notes, RUNTIME);
  } catch (e) {
    warnings.push("notes not written: " + String((e as Error).message || e));
  }

  const result: MergeResult = { ok: true, merged, archived, warnings };

  // An upgrade branch moves the app to the new template version.
  const up = branch.match(/^upgrade\/tpl-(v\d+\.\d+)$/);
  if (up) await registry(env).setTemplateVersion(repo, up[1]);

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
    const inst = await env.FAN_OUT.create({ id: repo + "-" + tag + "-" + Date.now().toString(36), params: { template: repo, tag, fixBranch: branch } });
    result.tag = tag;
    result.fanOut = inst.id;
  }

  // A workspace fork has done its job once its work is merged.
  if (lane.workspace) {
    const ws = lane.workspace;
    ctx.waitUntil(env.ARTIFACTS.delete(ws).then(() => undefined, () => undefined));
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
