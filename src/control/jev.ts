// Jev: the runtime's typed decisions.
//
// Every place the runtime has to choose -- which template a sentence wants,
// whether a conflict can be fixed at the edge or needs a shell -- is asked as a
// `choice` question to TypeSafe's Jev model on Workers AI, which answers with a
// probability per option rather than prose. The answer and its probabilities
// are written to `refs/notes/decision/jev`, so the reason for an escalation is
// in the repository, not in a log.
//
// If Jev is unavailable the same question goes to the edge model as JSON and
// the decision says so (`by: "fallback"`). D1 item 7 checks which one runs.

import type { Env } from "../env.ts";
import { completeJson } from "../agents/llm.ts";

export interface JevChoice {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  by: "typesafe/jev" | "fallback";
}

export async function choose(
  env: Env,
  state: string | Record<string, unknown>,
  question: string,
  options: Record<string, string>,
): Promise<JevChoice> {
  try {
    const out = (await env.AI.run("typesafe/jev" as never, {
      state,
      questions: { decision: { type: "choice", question, criteria: options } },
    } as never)) as {
      answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
    };
    const a = out && out.answers && out.answers.decision;
    if (a && a.choice && a.choice in options) {
      return {
        choice: a.choice,
        confidence: a.confidence ?? (a.probabilities ? a.probabilities[a.choice] : 0) ?? 0,
        probabilities: a.probabilities || { [a.choice]: a.confidence ?? 1 },
        by: "typesafe/jev",
      };
    }
  } catch {
    /* fall through to the edge model */
  }

  const { value } = await completeJson<{ choice: string; probabilities: Record<string, number> }>(env, [
    {
      role: "system",
      content:
        "You classify. Reply with JSON {\"choice\": <one option key>, \"probabilities\": {<key>: <0..1>}} and nothing else.",
    },
    {
      role: "user",
      content:
        "Question: " + question + "\n\nOptions:\n" +
        Object.entries(options).map(([k, v]) => "- " + k + ": " + v).join("\n") +
        "\n\nState:\n" + (typeof state === "string" ? state : JSON.stringify(state, null, 2)),
    },
  ]);
  const choice = value.choice in options ? value.choice : Object.keys(options)[0];
  const probabilities = value.probabilities || { [choice]: 1 };
  return { choice, confidence: probabilities[choice] ?? 0, probabilities, by: "fallback" };
}
