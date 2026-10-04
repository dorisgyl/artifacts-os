// NewApp: one sentence in, one running personal app out.
//
//   route (Jev picks a template) -> fork -> customise -> plan lanes ->
//   dispatch edge agents in parallel -> wait for their reviews -> merge -> register
//
// The first build merges automatically once the rules review passes: there is
// nothing yet for the owner to compare it with. Every change after this one
// goes through the approval bar.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { coordinator, registry } from "../env.ts";
import { listRepos, waitReady, withRepo, exists, TEMPLATE_PREFIX } from "../lib/artifacts.ts";
import { choose } from "../control/jev.ts";
import { completeJson } from "./llm.ts";
import { planNewApp } from "../control/planner.ts";
import { nextRun } from "../lib/cron.ts";
import { WorkingCopy, RUNTIME, MergeConflict } from "../git/ops.ts";
import { writeNotes } from "../git/notes.ts";
import type { Lane } from "../control/coordinator.ts";
import type { Json } from "../lib/json.ts";

export interface NewAppParams {
  need: string;
  name?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export class NewApp extends WorkflowEntrypoint<Env, NewAppParams> {
  async run(event: Readonly<WorkflowEvent<NewAppParams>>, step: WorkflowStep) {
    const env = this.env;
    const { need } = event.payload;
    const hub = (detail: string, data?: Json, status = "new-app") =>
      registry(env).publish({ at: Date.now(), repo: event.payload.name || "new-app", agent: "planner", kind: "new-app", status, detail, data });

    const route = await step.do("route", async () => {
      const templates = (await listRepos(env)).filter((r) => r.name.startsWith(TEMPLATE_PREFIX));
      if (!templates.length) throw new Error("no templates in the namespace; run setup first");
      const options: Record<string, string> = {};
      for (const t of templates) options[t.name] = t.description || t.name;
      const decision = await choose(env, { need }, "Which template fits this personal app?", options);
      await hub("template: " + decision.choice + " (" + Math.round(decision.confidence * 100) + "%, " + decision.by + ")", decision, "routed");
      return decision;
    });

    const named = await step.do("name", async () => {
      if (event.payload.name) return { name: slug(event.payload.name), schedule: null as string | null };
      try {
        const { value } = await completeJson<{ name: string; schedule: string | null }>(env, [
          {
            role: "system",
            content:
              'Name a personal app and its schedule. Reply {"name": "<2-3 word kebab-case, e.g. card-watch>", "schedule": "<5-field cron in UTC or null>"}.',
          },
          { role: "user", content: need },
        ]);
        // A schedule the runtime cannot evaluate falls back to the template's.
        let schedule: string | null = value.schedule || null;
        try {
          if (schedule) nextRun(schedule, Date.now());
        } catch {
          schedule = null;
        }
        return { name: slug(value.name || "") || "app-" + event.instanceId.slice(0, 6).toLowerCase(), schedule };
      } catch {
        return { name: "app-" + event.instanceId.slice(0, 6).toLowerCase(), schedule: null as string | null };
      }
    });
    let app = named.name;

    const fork = await step.do("fork", async () => {
      // Idempotent: a retry after a successful fork finds its own repo (same
      // description) and carries on instead of forking again.
      const description = need.slice(0, 180) + " [" + event.instanceId.slice(0, 8) + "]";
      const ours = async (name: string) => {
        if (!(await exists(env, name))) return "free";
        try {
          const info = await withRepo(env, name, (r) => r.info());
          return info.description === description ? "ours" : "taken";
        } catch (e) {
          // still forking: the fork this step already started
          return ((e as { code?: string }).code || "").endsWith("_IN_PROGRESS") ? "ours" : "taken";
        }
      };
      let state = await ours(app);
      if (state === "taken") {
        app = app + "-" + event.instanceId.replace(/[^a-z0-9]/gi, "").slice(0, 4).toLowerCase();
        state = await ours(app);
      }
      const started = Date.now();
      if (state === "free") await withRepo(env, route.choice, (t) => t.fork(app, { description }));
      await waitReady(env, app, 120000);
      const ms = Date.now() - started;
      await hub("forked " + route.choice + " → " + app + " in " + ms + " ms", { ms }, "forked");
      return { app, ms };
    });
    app = fork.app;

    const created = await step.do("customise", async () => {
      const coord = coordinator(env, app);
      const remote = (await coord.issue(app, "runtime", [{ repo: app, scope: "write" }], 600))[app];
      const wc = await WorkingCopy.clone(remote, { ref: "main" });
      const manifest = JSON.parse((await wc.read("app.json")) || "{}");
      const version = (manifest.template && manifest.template.version) || "v1.0";
      manifest.name = app;
      manifest.need = need;
      if (named.schedule) manifest.schedule = named.schedule;
      await wc.write("app.json", JSON.stringify(manifest, null, 2) + "\n");
      const oid = await wc.commit("Create " + app + " from " + route.choice + " " + version, RUNTIME);
      await coord.expectMain(app, oid);
      await wc.push(remote, "main");
      await writeNotes(
        wc,
        remote,
        [{ kind: "decision", writer: "jev", oid, body: { v: 1, by: route.by, decision: "template " + route.choice, reason: need, probabilities: route.probabilities, to: "all" } }],
        RUNTIME,
      );
      await registry(env).registerApp({
        name: app,
        need,
        template: route.choice,
        templateVersion: version,
        schedule: manifest.schedule || null,
        mainSha: oid,
      });
      return { oid, version };
    });

    const lanes = await step.do("plan", async () => {
      const planned = await planNewApp(env, app, need);
      await hub(planned.length + " lanes: " + planned.map((l) => l.branch).join(", "), planned.map((l) => l.agent), "planned");
      return planned;
    });

    await step.do("dispatch", async () => {
      const coord = coordinator(env, app);
      for (const l of lanes) await coord.startLane(app, { agent: l.agent, kind: "edge", branch: l.branch });
      await coord.waitFor({ workflow: "NEW_APP", instanceId: event.instanceId, agents: lanes.map((l) => l.agent), until: ["passed", "blocked", "failed"] });
      await env.AGENT_RUN.createBatch(
        lanes.map((l) => ({
          id: app + "-" + l.agent + "-" + Date.now().toString(36),
          params: { repo: app, agent: l.agent, branch: l.branch, task: l.task, allowed: l.allowed, target: l.target },
        })),
      );
      return lanes.length;
    });

    // If an agent never finishes, merge what passed rather than lose the app.
    let finished: Lane[];
    try {
      const done = await step.waitForEvent<{ lanes: Lane[] }>("lanes", { type: "lanes-done", timeout: "45 minutes" });
      finished = done.payload.lanes;
    } catch {
      finished = await step.do("lanes-after-timeout", async () =>
        JSON.parse(JSON.stringify(await coordinator(env, app).lanes())) as Lane[],
      );
    }
    const passed = finished.filter((l) => l && l.status === "passed" && l.head && lanes.some((x) => x.agent === l.agent));

    const merged = await step.do("merge", async () => {
      const coord = coordinator(env, app);
      const remote = (await coord.issue(app, "runtime", [{ repo: app, scope: "write" }], 600))[app];
      const wc = await WorkingCopy.clone(remote, { ref: "main", full: true });
      const out: string[] = [];
      for (const l of passed) {
        const tip = await wc.fetchRef(remote, "refs/heads/" + l.branch, "refs/heads/" + l.branch, { full: true });
        if (tip !== l.head) continue; // only what was reviewed
        try {
          const oid = await wc.merge("main", l.branch!, "Merge " + l.branch, RUNTIME);
          out.push(l.branch!);
          await coord.laneEvent(l.agent, "merged", "first build", { head: oid });
        } catch (e) {
          if (!(e instanceof MergeConflict)) throw e;
          await coord.laneEvent(l.agent, "blocked", "conflicts with " + out.join(", "));
          await wc.checkout("main");
        }
      }
      const head = await wc.resolve("main");
      await coord.expectMain(app, head);
      await wc.push(remote, "main");
      await registry(env).setMain(app, head);
      return { head, merged: out };
    });

    await hub("ready: /apps/" + app + "/ (" + merged.merged.length + "/" + lanes.length + " lanes merged)", { app, ...merged }, "ready");
    return { app, template: route.choice, forkMs: fork.ms, lanes: lanes.length, merged: merged.merged, head: merged.head, url: "/apps/" + app + "/" };
  }
}
