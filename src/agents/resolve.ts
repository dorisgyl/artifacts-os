// Resolving a merge conflict at the edge.
//
// Used when Jev judges a conflict to be a textual overlap a model can settle
// by reading both sides -- no tests to run, no tools to call. The resolved file
// must carry both intentions (the app's customisation and the template's fix)
// and no conflict markers; anything else is refused and the job escalates.

import type { Env } from "../env.ts";
import { completeJson } from "./llm.ts";
import { hasConflictMarkers } from "../git/ops.ts";

export async function resolveConflict(
  env: Env,
  input: { path: string; conflicted: string; ours: string | null; theirs: string | null; oursWhy: string; theirsWhy: string },
): Promise<{ content: string; model: string }> {
  const { value, completion } = await completeJson<{ content: string }>(env, [
    {
      role: "system",
      content:
        'You resolve one git merge conflict. Keep both intentions. Reply {"content": "<the whole resolved file>"} and nothing else. ' +
        "No conflict markers in the result.",
    },
    {
      role: "user",
      content:
        "File: " + input.path +
        "\n\nOurs (this app): " + input.oursWhy +
        "\nTheirs (template): " + input.theirsWhy +
        "\n\n## Conflicted file\n```\n" + input.conflicted + "\n```" +
        (input.ours !== null ? "\n\n## Ours before the merge\n```\n" + input.ours + "\n```" : "") +
        (input.theirs !== null ? "\n\n## Theirs\n```\n" + input.theirs + "\n```" : ""),
    },
  ]);
  const content = String(value.content || "");
  if (!content.trim() || hasConflictMarkers(content)) throw new Error("the model left conflict markers in " + input.path);
  return { content, model: completion.model };
}
