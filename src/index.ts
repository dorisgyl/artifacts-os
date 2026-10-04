// Artifacts-OS: the edge runtime for one person's agent.
//
// One Worker. Routes:
//   /               the Console (static, ./console)
//   /api/*          the Console's API
//   /apps/<repo>/   personal apps, loaded per commit as Dynamic Workers
//   /mcp            how outside agents join
// plus the hourly cron that runs apps on their own schedules, and the classes
// the platform instantiates: coordinators, the registry, the container host,
// the app capability and the four workflows.

import type { Env } from "./env.ts";
import { coordinator, registry } from "./env.ts";
import { identify } from "./lib/identity.ts";
import { ensureSeeds } from "./control/setup.ts";
import { serveApp } from "./apps/host.ts";
import { changedAgainstMain } from "./apps/approval-bar.ts";
import { mergeBranch } from "./apps/merge.ts";
import { uploadStatements, runNow, runDue, requestChange } from "./control/apps.ts";
import { memoryLog, revertMemory } from "./control/memory.ts";
import { handleMcp } from "./mcp/server.ts";
import { headOf, listRepos } from "./lib/artifacts.ts";

export { RepoCoordinator } from "./control/coordinator.ts";
export { UserIndex } from "./control/user-index.ts";
export { TaskHost } from "./container/task-host.js";
export { RepoCapability } from "./apps/capability.ts";
export { AgentRun } from "./agents/agent-run.ts";
export { ReviewOnPush } from "./agents/review-on-push.ts";
export { NewApp } from "./agents/new-app.ts";
export { FanOut } from "./agents/fan-out.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

async function api(request: Request, env: Env, ctx: ExecutionContext, path: string[], url: URL): Promise<Response> {
  const method = request.method;
  const [a, b, c] = path;

  if (a === "state" && method === "GET") {
    const seeds = await ensureSeeds(env);
    const reg = registry(env);
    const [apps, meters, repos] = await Promise.all([reg.apps(), reg.meters(), listRepos(env)]);
    return json({
      apps,
      meters,
      templates: repos.filter((r) => r.name.startsWith("tpl-")),
      created: seeds.created,
    });
  }

  if (a === "watch") {
    return reg(env).fetch(new Request("https://registry/watch", request));
  }

  if (a === "events" && method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const events = await registry(env).events(since, 5000);
    if (url.pathname.endsWith(".ndjson")) {
      return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return json({ events });
  }

  if (a === "needs" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { need?: string; name?: string };
    if (!body.need || !body.need.trim()) return json({ error: "need is required" }, 400);
    await ensureSeeds(env);
    const inst = await env.NEW_APP.create({ params: { need: body.need.trim(), name: body.name } });
    return json({ ok: true, workflow: inst.id, startedAt: Date.now() });
  }

  if (a === "apps" && b && NAME.test(b)) {
    const app = b;
    if (c === "statements" && method === "POST") {
      const form = await request.formData();
      const files: { name: string; bytes: Uint8Array; type: string }[] = [];
      for (const v of form.getAll("file")) {
        if (typeof v === "string") continue;
        const f = v as unknown as File;
        files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), type: f.type });
      }
      if (!files.length) return json({ error: "no files" }, 400);
      return json(await uploadStatements(env, app, files));
    }
    if (c === "run" && method === "POST") {
      const r = await runNow(env, ctx.exports, app);
      return json({ ok: true, summary: r.result.summary, committed: r.committed });
    }
    if (c === "change" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { request?: string };
      if (!body.request) return json({ error: "request is required" }, 400);
      return json(await requestChange(env, app, body.request));
    }
    if (c === "lanes" && method === "GET") {
      return json({ lanes: await coordinator(env, app).lanes(), expectedMain: await coordinator(env, app).expectedMain() });
    }
  }

  if (a === "repos" && b && NAME.test(b)) {
    const repo = b;
    if (c === "merge" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { branch?: string; reason?: string };
      if (!body.branch) return json({ error: "branch is required" }, 400);
      const r = await mergeBranch(env, ctx, repo, body.branch, body.reason || "");
      return json(r, r.ok ? 200 : 409);
    }
    if (c === "read-token" && method === "POST") {
      // For `npm run mirror`: a fifteen-minute read token, recorded and
      // revocable like every other token the runtime hands out.
      const r = await coordinator(env, repo).issue(repo, "mirror", [{ repo, scope: "read" }], 900);
      return json(r[repo]);
    }
    if (c === "diff" && method === "GET") {
      const ref = url.searchParams.get("ref") || "main";
      const sha = await headOf(env, repo, ref);
      if (!sha) return json({ error: "no such ref" }, 404);
      return json({ sha, changed: await changedAgainstMain(env, repo, sha) });
    }
  }

  if (a === "memory") {
    if (method === "GET") return json({ commits: await memoryLog(env) });
    if (b === "revert" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { sha?: string };
      if (!body.sha || !/^[0-9a-f]{40}$/.test(body.sha)) return json({ error: "sha is required" }, 400);
      return json({ ok: true, revert: await revertMemory(env, body.sha) });
    }
  }

  return json({ error: "not found" }, 404);
}

function reg(env: Env) {
  return registry(env);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const top = parts[0] || "";

    if (top !== "api" && top !== "apps" && top !== "mcp") {
      return env.ASSETS.fetch(request);
    }

    const id = await identify(request, env, ctx);
    if ("error" in id) return json(id, id.error === "not-the-owner" ? 403 : 401);

    try {
      if (top === "mcp") return await handleMcp(request, env);
      if (top === "apps") return await serveApp(env, ctx.exports, request, parts.slice(1));
      if (parts[1] === "whoami") return json(id);
      return await api(request, env, ctx, parts.slice(1), url);
    } catch (e) {
      const err = e as { message?: string; code?: string };
      return json({ error: err.message || String(e), code: err.code }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDue(env, ctx.exports).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
