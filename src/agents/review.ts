// Reviewing one pushed ref against the owner's rules.
//
// Called by the ReviewOnPush workflow for every push in the namespace, and
// directly by an agent when push events are not available (REVIEW_MODE=direct,
// the D1 fallback). The verdict is written to Git as a review note on the
// pushed commit, and to the coordinator for the Console and the approval bar.

import type { Env } from "../env.ts";
import { coordinator } from "../env.ts";
import { WorkingCopy, RUNTIME } from "../git/ops.ts";
import { writeNotes } from "../git/notes.ts";
import { readText, headOf } from "../lib/artifacts.ts";
import { toJson } from "../lib/json.ts";
import { review, type ReviewResult, type RulesFile, type ChangedContent } from "../rules/check.ts";

export const AUDITOR = "rules-auditor";

export async function reviewRef(env: Env, repo: string, branch: string, sha: string): Promise<ReviewResult> {
  const coord = coordinator(env, repo);
  // A push nobody announced -- the owner with plain git, say -- is reviewed all
  // the same, under a lane named after the branch.
  const lane =
    (await coord.laneByBranch(branch)) || (await coord.startLane(repo, { agent: "git:" + branch, kind: "external", branch }));
  await coord.laneEvent(lane.agent, "reviewing", undefined, { head: sha });

  const rulesText = await readText(env, "rules", "main", "rules.json");
  const rulesSha = (await headOf(env, "rules", "main")) || "";
  const rules: RulesFile = rulesText ? JSON.parse(rulesText) : { version: 0, rules: [] };
  const appText = await readText(env, repo, "main", "app.json");
  const app = appText ? JSON.parse(appText) : null;

  const remote = (await coord.issue(repo, AUDITOR, [{ repo, scope: "write" }], 600))[repo];
  const wc = await WorkingCopy.clone(remote, { ref: "main", full: true });
  await wc.fetchRef(remote, "refs/heads/" + branch, "refs/heads/" + branch, { full: true });
  const main = await wc.resolve("main");
  const base = (await wc.mergeBase(main, sha)) || main;
  const changed: ChangedContent[] = [];
  for (const c of await wc.changed(base, sha)) {
    changed.push({ ...c, content: c.type === "delete" ? null : await wc.readAt(sha, c.path) });
  }

  const result = review({ repo, branch, rules, app, changed });
  await writeNotes(
    wc,
    remote,
    [
      {
        kind: "review",
        writer: AUDITOR,
        oid: sha,
        body: { v: 1, auditor: AUDITOR, verdict: result.verdict, rulesCommit: rulesSha, findings: result.findings },
      },
      ...(result.verdict === "reject"
        ? [
            {
              kind: "outcome" as const,
              writer: "rules",
              oid: sha,
              body: { v: 1, source: "rules", outcome: "blocked", detail: result.findings.map((f) => f.rule).join(", ") },
            },
          ]
        : []),
    ],
    RUNTIME,
  );
  await coord.laneEvent(
    lane.agent,
    result.verdict === "pass" ? "passed" : "blocked",
    result.verdict === "pass" ? "rules pass" : result.findings[0]?.detail,
    { review: toJson(result), head: sha },
  );
  return result;
}
