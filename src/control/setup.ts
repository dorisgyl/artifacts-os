// First run: create the owner's cognitive repositories and the template.
//
// No setup script touches Artifacts. The runtime creates `rules`, `memory`,
// `experience` and every `tpl-*` from the files bundled at build time the
// first time anything asks for them, so a fresh deploy is usable immediately.

import type { Env } from "../env.ts";
import { registry } from "../env.ts";
import { BUNDLE } from "../generated/bundle.ts";
import { exists } from "../lib/artifacts.ts";
import { WorkingCopy, RUNTIME } from "../git/ops.ts";

const DESCRIPTIONS: Record<string, string> = {
  rules: "What every agent must respect. Read-only to agents.",
  memory: "What the agent has learned about its owner.",
  experience: "How the agent has solved things before: playbooks and prompts.",
};

let seeded = false;

export async function ensureSeeds(env: Env): Promise<{ created: string[] }> {
  if (seeded) return { created: [] };
  const created: string[] = [];
  const all: [string, Record<string, string>, boolean][] = [
    ...Object.entries(BUNDLE.seeds).map(([n, f]) => [n, f, false] as [string, Record<string, string>, boolean]),
    ...Object.entries(BUNDLE.templates).map(([n, f]) => [n, f, true] as [string, Record<string, string>, boolean]),
  ];
  for (const [name, files, isTemplate] of all) {
    if (await exists(env, name)) continue;
    let description = DESCRIPTIONS[name] || name;
    if (isTemplate) {
      try {
        description = JSON.parse(files["app.json"]).description || description;
      } catch {
        /* keep the name */
      }
    }
    let repo: ArtifactsCreateRepoResult;
    try {
      repo = await env.ARTIFACTS.create(name, { description, setDefaultBranch: "main" });
    } catch (e) {
      if ((e as { code?: string }).code === "ALREADY_EXISTS") continue; // another request won the race
      throw e;
    }
    const remote = { url: repo.remote, token: repo.token };
    const wc = await WorkingCopy.init("main");
    for (const [path, content] of Object.entries(files)) await wc.write(path, content);
    const oid = await wc.commit(isTemplate ? "Template " + name + " v1.0" : "Seed " + name, RUNTIME);
    await wc.push(remote, "main");
    if (isTemplate) {
      await wc.tag("v1.0", oid);
      await wc.push(remote, "refs/tags/v1.0");
    }
    created.push(name);
    await registry(env).publish({ at: Date.now(), repo: name, agent: "runtime", kind: "setup", status: "created", detail: description });
  }
  seeded = true;
  return { created };
}
