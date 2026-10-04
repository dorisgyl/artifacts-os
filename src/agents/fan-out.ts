// FanOut: a template fix reaches every app built from that template.
//
// For each sibling, a merge agent merges the new template version into an
// `upgrade/tpl-<tag>` branch. What happens next depends on what the merge
// finds, and Jev makes the call:
//
//   clean, no gates      -> push; the owner previews and merges       (green)
//   conflict, textual    -> resolve at the edge with the model; push  (amber)
//   needs a shell        -> escalate to a container with its own fork (red)

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { coordinator, registry } from "../env.ts";
import { WorkingCopy, RUNTIME, MergeConflict, agentAuthor } from "../git/ops.ts";
import { writeNotes } from "../git/notes.ts";
import { choose } from "../control/jev.ts";
import { toJson } from "../lib/json.ts";
import { resolveConflict } from "./resolve.ts";
import { escalateToContainer, containerObjective } from "../control/escalate.ts";

export interface FanOutParams {
  template: string;
  tag: string;
  fixBranch?: string;
}

export class FanOut extends WorkflowEntrypoint<Env, FanOutParams> {
  async run(event: Readonly<WorkflowEvent<FanOutParams>>, step: WorkflowStep) {
    const { template, tag } = event.payload;
    const siblings = await step.do("siblings", async () => (await registry(this.env).siblings(template)).map((a) => a.name));
    const results: Record<string, unknown> = {};
    // One step per app: a failure in one never stops the others.
    for (const app of siblings) {
      try {
        results[app] = await step.do("upgrade:" + app, { retries: { limit: 1, delay: "10 seconds" } }, () =>
          this.upgrade(app, template, tag),
        );
      } catch (e) {
        const error = String((e as Error).message || e).slice(0, 300);
        results[app] = { app, error };
        await coordinator(this.env, app).laneEvent("merge-" + tag.replace(/\./g, "-"), "failed", error);
      }
    }
    return { template, tag, results };
  }

  private async upgrade(app: string, template: string, tag: string) {
    const env = this.env;
    const coord = coordinator(env, app);
    const agent = "merge-" + tag.replace(/\./g, "-");
    const branch = "upgrade/tpl-" + tag;
    await coord.startLane(app, { agent, kind: "merge", branch, strategy: "merge " + template + " " + tag });

    const remotes = await coord.issue(app, agent, [
      { repo: app, scope: "write" },
      { repo: template, scope: "read" },
    ], 900);
    const wc = await WorkingCopy.clone(remotes[app], { ref: "main", full: true });
    const theirs =
      (await wc.fetchRef(remotes[template], "refs/tags/" + tag, "refs/heads/tpl-" + tag, { full: true }).catch(() => null)) ||
      (await wc.fetchRef(remotes[template], "refs/heads/main", "refs/heads/tpl-" + tag, { full: true }));
    if (!theirs) throw new Error("cannot fetch " + template + " " + tag);
    await wc.checkout("main", { create: branch });
    const oursBefore = await wc.resolve(branch);

    const manifest = JSON.parse((await wc.read("app.json")) || "{}");
    const gates: string[] = (manifest.gates && manifest.gates.beforeMerge) || [];

    let conflicts: string[] = [];
    try {
      await wc.merge(branch, "tpl-" + tag, "Merge " + template + " " + tag, agentAuthor(agent));
    } catch (e) {
      if (!(e instanceof MergeConflict)) throw e;
      conflicts = e.files;
    }

    // app.json is the template's file with this app's own identity on top:
    // take the template's version and keep the app's name, need, schedule and
    // gates. That also settles any conflict in it.
    let theirsManifest: Record<string, unknown> = {};
    try {
      theirsManifest = JSON.parse((await wc.readAt(theirs, "app.json")) || "{}");
    } catch {
      /* the template's manifest is unreadable: keep ours */
      theirsManifest = { ...manifest };
    }
    const keep = { name: manifest.name, need: manifest.need, schedule: manifest.schedule, gates: manifest.gates };
    const mergedManifest = { ...theirsManifest, ...keep };
    const currentText = await wc.read("app.json");
    const wanted = JSON.stringify(mergedManifest, null, 2) + "\n";
    if (currentText !== wanted) await wc.write("app.json", wanted);
    // Whether git left the merge unfinished, even if only app.json conflicted.
    const mergeConflicted = conflicts.length > 0;
    conflicts = conflicts.filter((f) => f !== "app.json");

    if (!conflicts.length && !gates.length) {
      await this.finishAndPush(wc, remotes[app], app, agent, branch, theirs, mergeConflicted, null);
      return { app, path: "clean" };
    }

    const markers: Record<string, string> = {};
    for (const f of conflicts) markers[f] = ((await wc.read(f)) || "").slice(0, 3000);
    const decision = await choose(
      env,
      { app, tag, conflicts, gates, markers },
      "Can this template upgrade be finished at the edge, or does it need a container with a shell?",
      {
        edge: "Only a textual overlap that a model can settle by reading both sides; nothing has to be executed.",
        container: "Something has to run before this can merge (tests, a build, tools), so it needs a shell.",
      },
    );
    const decisionNote: { v: number; by: string; decision: string; reason: string; probabilities: Record<string, number>; to: string } = {
      v: 1,
      by: decision.by,
      decision: decision.choice,
      reason: gates.length ? "gates before merge: " + gates.join(", ") : "conflicts: " + conflicts.join(", "),
      probabilities: decision.probabilities,
      to: decision.choice === "container" ? "codex-container" : agent,
    };
    await coord.laneEvent(agent, "started", "Jev: " + decision.choice + " (" + Math.round(decision.confidence * 100) + "%)", { decision: toJson(decisionNote) });

    if (decision.choice === "edge" && !gates.length) {
      let resolved = true;
      for (const f of conflicts) {
        try {
          const r = await resolveConflict(env, {
            path: f,
            conflicted: (await wc.read(f)) || "",
            ours: await wc.readAt(oursBefore, f),
            theirs: await wc.readAt(theirs, f),
            oursWhy: "the app's own customisation of template code",
            theirsWhy: "the template fix released as " + tag,
          });
          await wc.write(f, r.content);
        } catch (e) {
          // The edge could not settle it: that is exactly what the container is for.
          resolved = false;
          decisionNote.reason += "; edge resolution failed: " + String((e as Error).message || e).slice(0, 120);
          decisionNote.to = "codex-container";
          break;
        }
      }
      if (resolved) {
        await this.finishAndPush(wc, remotes[app], app, agent, branch, theirs, true, decisionNote);
        return { app, path: "edge", conflicts };
      }
    }

    // Container: commit the merge as it stands (markers included, if any) on
    // the upgrade branch and hand it over.
    await this.commitPending(wc, branch, theirs, mergeConflicted, agent, "Merge " + template + " " + tag + (conflicts.length ? " (unresolved)" : ""));
    await coord.laneEvent(agent, "done", "handed to codex-container");
    const esc = await escalateToContainer(env, {
      app,
      branch,
      wc,
      objective: containerObjective({ app, branch, gates, conflicts, tag }),
      decision: { by: decision.by, reason: decisionNote.reason, probabilities: decision.probabilities },
    });
    return { app, path: "container", ...esc };
  }

  /** Commit what the merge left in the worktree: a resolved conflict, or a manifest fix-up. */
  private async commitPending(wc: WorkingCopy, branch: string, theirs: string, conflicted: boolean, agent: string, message: string) {
    if (conflicted) return wc.commitMerge(branch, theirs, message, agentAuthor(agent));
    const head = await wc.resolve(branch);
    if (await this.dirty(wc, head)) return wc.commit("Keep this app's manifest across the template upgrade", agentAuthor(agent));
    return head;
  }

  private async finishAndPush(
    wc: WorkingCopy,
    remote: { url: string; token: string },
    app: string,
    agent: string,
    branch: string,
    theirs: string,
    conflicted: boolean,
    decision: unknown,
  ) {
    const coord = coordinator(this.env, app);
    const head = await this.commitPending(wc, branch, theirs, conflicted, agent, "Merge template into " + app + " (resolved at the edge)");
    await wc.push(remote, "refs/heads/" + branch, { force: true });
    const notes: { kind: "intent" | "decision"; writer: string; oid: string; body: unknown }[] = [
      {
        kind: "intent",
        writer: agent,
        oid: head,
        body: { v: 1, agent, status: "pushed", direction: "upgrade to the new template version", branch, to: "all", at: new Date().toISOString() },
      },
    ];
    if (decision) notes.push({ kind: "decision", writer: "jev", oid: head, body: decision });
    await writeNotes(wc, remote, notes, RUNTIME);
    await coord.laneEvent(agent, "pushed", decision ? "conflict resolved at the edge" : "clean merge", { head });
  }

  /** True when the worktree differs from the commit (an edit after the merge). */
  private async dirty(wc: WorkingCopy, head: string) {
    for (const p of await wc.files()) {
      const committed = await wc.readAt(head, p);
      if (committed !== (await wc.read(p))) return true;
    }
    return false;
  }
}
