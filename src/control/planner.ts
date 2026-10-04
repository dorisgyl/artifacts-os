// The planner: turns a sentence into lanes.
//
// For a new app the split comes from the template itself -- its AGENTS.md
// declares the lanes, and the Transaction shape between them is why they can
// run at once. For a change request, the owner's experience repository is
// consulted first: a matching playbook turns into competing attempts, one per
// strategy. Nothing here is hard-coded per demo.

import type { Env } from "../env.ts";
import { readText, readTreeFiles, headOf } from "../lib/artifacts.ts";
import { choose, type JevChoice } from "./jev.ts";

export interface Strategy {
  id: string;
  branch: string;
  summary: string;
  risk?: string;
}

export interface Playbook {
  id: string;
  title: string;
  when: string;
  strategies: Strategy[];
}

export interface PlannedLane {
  agent: string;
  branch: string;
  task: string;
  strategy?: Strategy;
  repo: string;
  allowed: string[];
  target: "app" | "template";
  origin?: string;
}

export function parseLanes(agentsMd: string): { name: string; text: string }[] {
  const section = agentsMd.split(/^## /m).find((s) => s.startsWith("Lanes"));
  if (!section) return [];
  const out: { name: string; text: string }[] = [];
  const re = /^- \*\*([a-z0-9-]+)\*\*\s*[—-]\s*([\s\S]*?)(?=^- \*\*|(?![\s\S]))/gm;
  for (const m of section.matchAll(re)) out.push({ name: m[1], text: m[2].replace(/\s+/g, " ").trim() });
  return out;
}

export async function planNewApp(env: Env, app: string, need: string): Promise<PlannedLane[]> {
  const [agentsMd, manifestText] = await Promise.all([
    readText(env, app, "main", "AGENTS.md"),
    readText(env, app, "main", "app.json"),
  ]);
  const manifest = JSON.parse(manifestText || "{}");
  const lanes = parseLanes(agentsMd || "");
  const allowed: string[] = manifest.agentPaths || [];
  if (!lanes.length) {
    return [{ agent: "edge-build", branch: "agent/build", task: need, repo: app, allowed, target: "app" }];
  }
  return lanes.map((l) => ({
    agent: "edge-" + l.name,
    branch: "agent/" + l.name,
    task: need + "\n\nYour lane: " + l.name + " — " + l.text,
    repo: app,
    allowed,
    target: "app" as const,
  }));
}

export async function playbooks(env: Env): Promise<Playbook[]> {
  const sha = await headOf(env, "experience", "main");
  if (!sha) return [];
  const files = await readTreeFiles(env, "experience", sha, (p) => p.startsWith("playbooks/") && p.endsWith(".json"));
  const out: Playbook[] = [];
  for (const text of Object.values(files)) {
    try {
      out.push(JSON.parse(text));
    } catch {
      /* a broken playbook is skipped, not fatal */
    }
  }
  return out;
}

export interface ChangePlan {
  kind: "playbook" | "single" | "template-fix";
  decision: JevChoice;
  playbook?: Playbook;
  lanes: PlannedLane[];
}

/**
 * Decide how to attack a change request on an existing app. Jev picks between
 * the matching playbooks, a single agent, or a fix in the template.
 */
export async function planChange(env: Env, app: string, request: string, context: string): Promise<ChangePlan> {
  const [books, manifestText] = await Promise.all([playbooks(env), readText(env, app, "main", "app.json")]);
  const manifest = JSON.parse(manifestText || "{}");
  const template = (manifest.template && manifest.template.repo) || null;

  const options: Record<string, string> = {
    single: "One agent can make this change inside the app's own code.",
  };
  if (template) {
    options["template-fix"] =
      "The problem is in shared template code (" + (manifest.templatePaths || []).join(", ") + "), so it must be fixed in the template for every app.";
  }
  for (const b of books) options["playbook:" + b.id] = b.title + ". " + b.when;

  const decision = await choose(
    env,
    { app, request, context: context.slice(0, 4000) },
    "Which way should this change request be handled?",
    options,
  );

  if (decision.choice.startsWith("playbook:")) {
    const playbook = books.find((b) => "playbook:" + b.id === decision.choice)!;
    return {
      kind: "playbook",
      decision,
      playbook,
      lanes: playbook.strategies.map((s) => ({
        agent: "attempt-" + s.id,
        branch: s.branch,
        task: request,
        strategy: s,
        repo: app,
        allowed: manifest.agentPaths || [],
        target: "app" as const,
      })),
    };
  }
  if (decision.choice === "template-fix" && template) {
    const tplManifest = JSON.parse((await readText(env, template, "main", "app.json")) || "{}");
    const slug = request.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "fix";
    return {
      kind: "template-fix",
      decision,
      lanes: [
        {
          agent: "fix-" + app,
          branch: "fix/" + slug,
          task: request + "\n\nFound while running " + app + ". Fix it in the template so every app built from it gets the fix.",
          repo: template,
          allowed: tplManifest.templatePaths || manifest.templatePaths || [],
          target: "template",
          origin: app,
        },
      ],
    };
  }
  const slug = request.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "change";
  return {
    kind: "single",
    decision,
    lanes: [
      { agent: "change-" + slug.slice(0, 16), branch: "change/" + slug, task: request, repo: app, allowed: manifest.agentPaths || [], target: "app" },
    ],
  };
}
