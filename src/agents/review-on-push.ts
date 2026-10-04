// ReviewOnPush: started by Artifacts for every push in the namespace.
//
// This is how the runtime hears about work it did not start. An agent that
// joined over MCP and pushed with plain git, Codex pushing from a container,
// the owner pushing from a laptop -- each push lands here, and gets the same
// treatment as the runtime's own agents:
//
//   - a push to a workspace fork is brought into the app repository as a branch;
//   - a push to main that the runtime did not make is put back (main guard);
//   - every other branch is reviewed against the owner's rules.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { coordinator } from "../env.ts";
import { WorkingCopy, RUNTIME } from "../git/ops.ts";
import { writeNotes, notesRef, parseNotesRef } from "../git/notes.ts";
import { parseWorkspace, SEED_REPOS } from "../lib/artifacts.ts";
import { reviewRef } from "./review.ts";
import { mergeBranch } from "../apps/merge.ts";

interface PushedEvent {
  type?: string;
  source?: { namespace?: string; repoName?: string; repo_name?: string };
  payload?: { ref?: string; before?: string; after?: string };
}

const ZERO = /^0{40}$/;

export function parsePush(raw: unknown): { repo: string; ref: string; after: string } | null {
  // The event arrives as the workflow payload; accept it bare or wrapped.
  const e = ((raw as { event?: PushedEvent }).event || raw) as PushedEvent;
  const repo = e.source && (e.source.repoName || e.source.repo_name);
  const ref = e.payload && e.payload.ref;
  const after = e.payload && e.payload.after;
  if (!repo || !ref || !after || ZERO.test(after)) return null;
  return { repo, ref, after };
}

export class ReviewOnPush extends WorkflowEntrypoint<Env, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep) {
    const push = parsePush(event.payload);
    if (!push) return { skipped: "not a push we act on" };
    const { repo, ref, after } = push;
    const ws = parseWorkspace(repo);

    // An outside agent's notes may arrive in a push of their own, before or
    // after its branch. Bring over only the refs that agent writes.
    if (ws && ref.startsWith("refs/notes/")) {
      return step.do("import-notes", async () => ({ imported: await this.importNotes(repo, ws.app, ws.agent) }));
    }
    // Otherwise notes and tags are conversation and releases, not changes to
    // review -- and the runtime's own note pushes must not start another review.
    if (!ref.startsWith("refs/heads/")) return { skipped: ref };
    const branch = ref.slice("refs/heads/".length);
    if (branch.startsWith("archive/")) return { skipped: "archive" };

    if (ws) {
      const imported = await step.do("import", () => this.importFromWorkspace(repo, ws.app, ws.agent, branch, after));
      if (!imported) return { skipped: "not imported" };
      const verdict = await this.reviewStep(step, ws.app, imported.branch, after);
      return { repo: ws.app, branch: imported.branch, verdict };
    }

    if (branch === "main") {
      return step.do("guard", () => this.guardMain(repo, after));
    }

    const review = await this.reviewStep(step, repo, branch, after, true);
    // A playbook the container wrote is merged into experience once it passes
    // review -- and only if it touches nothing but playbooks.
    if (review === "pass" && repo === "experience" && branch.startsWith("playbook/")) {
      await step.do("merge-playbook", async () => {
        const r = await mergeBranch(this.env, this.ctx, repo, branch, "playbook passed review", after);
        return { ok: r.ok, error: r.error || null };
      });
    }
    return { repo, branch, verdict: review };
  }

  /** Review, and if it cannot be done, say so on the lane instead of leaving it "reviewing". */
  private async reviewStep(step: WorkflowStep, repo: string, branch: string, sha: string, playbookCheck = false) {
    try {
      return await step.do("review", async () => {
        const r = await reviewRef(this.env, repo, branch, sha);
        if (playbookCheck && repo === "experience" && r.paths.some((p) => !/^playbooks\/[A-Za-z0-9._-]+\.json$/.test(p))) {
          return "reject" as const; // experience changes beyond playbooks need the owner
        }
        return r.verdict;
      });
    } catch (e) {
      const lane = await coordinator(this.env, repo).laneByBranch(branch);
      if (lane) await coordinator(this.env, repo).laneEvent(lane.agent, "failed", "review could not run: " + String((e as Error).message || e).slice(0, 200), { head: sha });
      throw e;
    }
  }

  private async importNotes(workspace: string, app: string, agent: string): Promise<string[]> {
    const coord = coordinator(this.env, app);
    const lane = await coord.laneByWorkspace(workspace);
    const writer = lane ? lane.agent : agent;
    const remotes = await coord.issue(app, "importer", [
      { repo: workspace, scope: "read" },
      { repo: app, scope: "write" },
    ], 600);
    const wc = await WorkingCopy.clone(remotes[app], { ref: "main" });
    const out: string[] = [];
    for (const r of await wc.listRemoteRefs(remotes[workspace], "refs/notes/")) {
      const parsed = parseNotesRef(r.ref);
      // One writer per ref: an agent may only bring back what it wrote. A
      // fork's copies of the reviewer's, Jev's or the owner's notes stay put.
      if (!parsed || parsed.writer !== writer || !["intent", "telemetry", "trace"].includes(parsed.kind)) continue;
      await wc.fetchRef(remotes[workspace], r.ref, r.ref);
      await wc.push(remotes[app], r.ref, { force: true });
      out.push(r.ref);
    }
    return out;
  }

  /**
   * Copy a branch from a workspace fork into the app repository. The fork is
   * the outside agent's whole write scope; only the runtime moves anything
   * from there into the app.
   */
  private async importFromWorkspace(workspace: string, app: string, agent: string, branch: string, after: string) {
    if (branch === "main") return null;
    const coord = coordinator(this.env, app);
    const lane = await coord.laneByWorkspace(workspace);
    const agentId = lane ? lane.agent : agent;
    const safe = branch.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/\.\.+/g, ".");
    let target: string;
    if (lane && lane.kind === "container") {
      // The container was given one branch; anything else it pushes is scratch.
      if (branch !== lane.branch) return null;
      target = branch;
    } else {
      target = "ext/" + agentId + "/" + safe;
    }

    const remotes = await coord.issue(app, "importer", [
      { repo: workspace, scope: "read" },
      { repo: app, scope: "write" },
    ], 600);
    const wc = await WorkingCopy.clone(remotes[app], { ref: "main", full: true });
    await wc.fetchRef(remotes[workspace], "refs/heads/" + branch, "refs/heads/" + target, { full: true });
    await wc.push(remotes[app], "refs/heads/" + target, { force: true });
    await this.importNotes(workspace, app, agent);
    if (!lane) await coord.startLane(app, { agent: agentId, kind: "external", branch: target, workspace });
    await coord.laneEvent(agentId, "pushed", "from " + workspace + " (" + branch + ")", { head: after, branch: target });
    return { branch: target };
  }

  private async guardMain(repo: string, after: string) {
    // rules, memory and experience are the owner's to edit with plain git.
    if ((SEED_REPOS as readonly string[]).includes(repo)) return { repo, main: "owner repository" };
    const coord = coordinator(this.env, repo);
    if (await coord.isExpectedMain(after)) return { repo, main: "expected" };
    const expected = await coord.expectedMain();
    if (!expected) return { repo, main: "unguarded" };

    // A token is per repository, so a write token can move main. Put it back
    // and say so in the repository, where the owner will see it.
    const remote = (await coord.issue(repo, "guard", [{ repo, scope: "write" }], 300))[repo];
    const wc = await WorkingCopy.clone(remote, { ref: "main", full: true });
    await wc.fetchRef(remote, "refs/heads/main", "refs/heads/rejected-main");
    try {
      await wc.checkout(expected, { create: "restore" });
    } catch {
      // History was rewritten and the expected commit is gone from what the
      // server advertises. Say so; do not guess.
      await coord.note("guard", "main moved to " + after.slice(0, 8) + " and the expected " + expected.slice(0, 8) + " is unreachable; restore it by hand");
      return { repo, main: "unrestorable", expected, rejected: after };
    }
    await wc.push(remote, "refs/heads/restore", { remoteRef: "refs/heads/main", force: true });
    await wc.push(remote, "refs/heads/rejected-main", { remoteRef: "refs/heads/archive/rejected-main-" + after.slice(0, 8), force: true });
    await writeNotes(
      wc,
      remote,
      [
        {
          kind: "outcome",
          writer: "guard",
          oid: after,
          body: { v: 1, source: "guard", outcome: "guard-restored", detail: "main moved outside the runtime; restored to " + expected },
        },
      ],
      RUNTIME,
    );
    await coord.note("guard", "main moved to " + after.slice(0, 8) + " outside the runtime; restored " + expected.slice(0, 8), {
      ref: notesRef("outcome", "guard"),
    });
    return { repo, main: "restored", expected, rejected: after };
  }
}
