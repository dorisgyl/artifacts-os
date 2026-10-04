// The edge agent's one move: read the repository, write whole files back.
//
// It runs inside a Workflow step, with the repository in memory and a model
// behind AI Gateway. It sees the app's AGENTS.md, the files its lane may
// change, the owner's memory, its assigned strategy and what the other agents
// have claimed -- and replies with JSON. Anything outside its allowed paths is
// dropped before it can be committed; the rules review would reject it anyway.

import type { Env } from "../env.ts";
import { completeJson, type Completion } from "./llm.ts";
import { globMatch } from "../rules/check.ts";
import type { Strategy } from "../control/planner.ts";

export interface Proposal {
  intent: string;
  commit: string;
  files: { path: string; content: string }[];
  notes?: string;
}

export interface ProposalInput {
  repo: string;
  agent: string;
  task: string;
  strategy?: Strategy;
  allowed: string[];
  files: Record<string, string>;
  memory: Record<string, string>;
  others: { agent: string; direction: string; status: string }[];
  previousError?: string;
  extraContext?: string;
}

const REFERENCE = ["AGENTS.md", "app.json", "config.json", "src/types.js", "src/csv.js", "src/pipeline.js", "tests/harness.js"];

function head(text: string, lines: number) {
  return text.split("\n").slice(0, lines).join("\n");
}

export function buildPrompt(input: ProposalInput, system: string) {
  const parts: string[] = [];
  parts.push("# Task\n" + input.task);
  if (input.strategy) {
    parts.push(
      "# Your assigned strategy: " + input.strategy.id + "\n" + input.strategy.summary +
        (input.strategy.risk ? "\nKnown risk: " + input.strategy.risk : ""),
    );
  }
  if (input.others.length) {
    parts.push(
      "# What the other agents have claimed (do not duplicate them)\n" +
        input.others.map((o) => "- " + o.agent + " [" + o.status + "]: " + o.direction).join("\n"),
    );
  }
  parts.push("# Paths you may change\n" + input.allowed.join("\n"));

  for (const p of REFERENCE) {
    if (input.files[p] !== undefined) parts.push("## " + p + " (reference)\n```\n" + input.files[p] + "\n```");
  }
  for (const [p, text] of Object.entries(input.files)) {
    if (REFERENCE.includes(p) || !input.allowed.some((g) => globMatch(g, p))) continue;
    if (p.startsWith("tests/fixtures/")) parts.push("## " + p + " (first lines)\n```\n" + head(text, 15) + "\n```");
    else parts.push("## " + p + "\n```\n" + text + "\n```");
  }
  for (const [p, text] of Object.entries(input.files)) {
    if (p.startsWith("data/statements/") && !p.endsWith("README.md")) {
      parts.push("## " + p + " (first lines of an uploaded statement)\n```\n" + head(text, 25) + "\n```");
    }
  }
  for (const [p, text] of Object.entries(input.memory)) {
    parts.push("## memory/" + p + "\n```\n" + text + "\n```");
  }
  if (input.extraContext) parts.push("# Context\n" + input.extraContext);
  if (input.previousError) {
    parts.push("# Your previous attempt failed when the app ran\n" + input.previousError + "\nFix it.");
  }
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: parts.join("\n\n") },
  ];
}

export async function propose(
  env: Env,
  input: ProposalInput,
  system: string,
): Promise<{ proposal: Proposal; completion: Completion; dropped: string[] }> {
  const { value, completion } = await completeJson<Proposal>(env, buildPrompt(input, system), {
    temperature: 0.1,
    maxTokens: 12000,
  });
  const files = Array.isArray(value.files) ? value.files : [];
  const kept = files.filter((f) => f && typeof f.path === "string" && typeof f.content === "string" && input.allowed.some((g) => globMatch(g, f.path)));
  const dropped = files.filter((f) => !kept.includes(f)).map((f) => String(f && f.path));
  if (!kept.length) throw new Error("the model proposed no files inside the allowed paths" + (dropped.length ? " (dropped: " + dropped.join(", ") + ")" : ""));
  return {
    proposal: {
      intent: String(value.intent || "").slice(0, 400),
      commit: String(value.commit || "Agent change").split("\n")[0].slice(0, 72),
      files: kept,
      notes: value.notes ? String(value.notes).slice(0, 1000) : undefined,
    },
    completion,
    dropped,
  };
}

export const DEFAULT_SYSTEM = `You are one agent among several working on a personal app repository at the
same time. Do your lane only. Reply with one JSON object and nothing else:
{"intent": "one sentence for the other agents", "commit": "one-line title",
 "files": [{"path": "...", "content": "the whole new file"}], "notes": "for the reviewer"}
Write whole files. Only the allowed paths. Plain ES modules, relative imports only,
no dependencies, no network calls, card numbers as last four digits only.`;
