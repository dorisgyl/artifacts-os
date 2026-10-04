// Escalation: the one path to a container.
//
// Most work never leaves the edge. When Jev decides a job needs a shell --
// tests to run, tools Workers do not have -- the runtime gives Codex what an
// outside agent gets: its own fork of the app, a one-hour write token for that
// fork and nothing else, plus Jev's decision note saying why it was called.
// Codex pushes its result to the fork; the push event brings it back.

import type { Env } from "../env.ts";
import { coordinator, registry, OWNER, REGISTRY_NAME } from "../env.ts";
import { withRepo, waitReady, workspaceName, remoteFor } from "../lib/artifacts.ts";
import { WorkingCopy, RUNTIME, secretOf } from "../git/ops.ts";
import { writeNotes } from "../git/notes.ts";

export const CONTAINER_AGENT = "codex-container";

export async function escalateToContainer(
  env: Env,
  input: {
    app: string;
    branch: string;
    wc: WorkingCopy;
    objective: string;
    decision: { by: string; reason: string; probabilities?: Record<string, number> };
  },
): Promise<{ workspace: string; taskId: string } | { refused: unknown }> {
  const admission = (await registry(env).admit()) as { ok: boolean };
  const coord = coordinator(env, input.app);
  if (!admission.ok) {
    await coord.laneEvent(CONTAINER_AGENT, "blocked", "container budget: " + JSON.stringify(admission));
    return { refused: admission };
  }

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const workspace = workspaceName(input.app, CONTAINER_AGENT, id);
  await withRepo(env, input.app, (r) => r.fork(workspace, { description: "container workspace for " + input.branch }));
  await waitReady(env, workspace);
  await coord.startLane(input.app, { agent: CONTAINER_AGENT, kind: "container", branch: input.branch, workspace });

  const remotes = await coord.issue(input.app, CONTAINER_AGENT, [{ repo: workspace, scope: "write" }], 3600);
  const ws = remotes[workspace];
  await input.wc.push(ws, "refs/heads/" + input.branch, { force: true });
  const head = await input.wc.resolve("refs/heads/" + input.branch);
  await writeNotes(
    input.wc,
    ws,
    [{ kind: "decision", writer: "jev", oid: head, body: { v: 1, ...input.decision, decision: "escalate to container", to: CONTAINER_AGENT } }],
    RUNTIME,
  );
  // The playbook the container writes goes to the experience repo on a branch.
  const experience = await remoteFor(env, "experience", "write", 3600);

  const taskId = crypto.randomUUID();
  const withCreds = (url: string, token: string) => url.replace("https://", "https://x:" + encodeURIComponent(secretOf(token)) + "@");
  const stub = env.TASK.get(env.TASK.idFromName(REGISTRY_NAME + "/task/" + taskId));
  const res = await stub.fetch(
    new Request("https://task/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: taskId,
        objective: input.objective,
        owner: OWNER,
        tokenBudget: 800000,
        wallClockSeconds: 30 * 60,
        artifacts: {
          app: input.app,
          workspace,
          branch: input.branch,
          agent: CONTAINER_AGENT,
          remote: withCreds(ws.url, ws.token),
          experienceRemote: withCreds(experience.url, experience.token),
        },
      }),
    }),
  );
  const body = (await res.json()) as { ok?: boolean; error?: string };
  if (!body.ok) {
    await coord.laneEvent(CONTAINER_AGENT, "failed", "container did not start: " + (body.error || res.status));
    return { refused: body };
  }
  await registry(env).record({ id: taskId, objective: input.objective, repo: input.app, branch: input.branch, phase: "booting" });
  await coord.laneEvent(CONTAINER_AGENT, "started", "container booting in " + workspace);
  return { workspace, taskId };
}

export function containerObjective(input: { app: string; branch: string; gates: string[]; conflicts: string[]; tag: string }) {
  return [
    "You are working in /workspace, a clone of " + input.app + " on branch " + input.branch + ".",
    "This branch merges template " + input.tag + " into the app. Read the decision note first:",
    "  git notes --ref=refs/notes/decision/jev show HEAD",
    input.conflicts.length
      ? "These files still contain conflict markers and must be resolved, keeping both the app's customisation and the template's fix: " + input.conflicts.join(", ") + "."
      : "The merge itself is clean.",
    input.gates.length ? "Before this can merge, these must pass: " + input.gates.join(", ") + ". Run them, fix what fails, run them again." : "",
    "Rules: change only what is needed; no new dependencies; no network calls in app code; card numbers as last four digits only.",
    "When everything passes: commit with a one-line message, then add a note explaining what failed and how you fixed it:",
    "  git notes --ref=refs/notes/intent/codex-container add -f -m '<what you did and why>' HEAD",
    "Then push the branch and your notes:",
    "  git push origin HEAD:refs/heads/" + input.branch + " && git push -f origin refs/notes/intent/codex-container",
    "Finally, if what you learned would help next time, write it as a playbook: clone \"$EXPERIENCE_GIT_REMOTE\" into /tmp/experience,",
    "add playbooks/<short-id>.json in the same shape as the existing playbooks, commit on a branch named playbook/<short-id>, and push that branch.",
  ]
    .filter(Boolean)
    .join("\n");
}
