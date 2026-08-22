// U1 -- the edge. The only unit reachable from the internet.
//
// It establishes who is asking, derives every object name from that identity
// alone, and forwards. The caller contributes the task segment and nothing
// else, so it cannot address another user's task (ADR-01).

import { identify } from "./access.js";
import { PAGE } from "./ui.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const indexName = (id) => "tenant/" + id.tenant + "/user/" + id.user;
const taskName = (id, task) => indexName(id) + "/task/" + task;

async function callIndex(env, id, path, body) {
  const stub = env.INDEX.get(env.INDEX.idFromName(indexName(id)));
  const res = await stub.fetch(
    new Request("https://index" + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return res.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (!url.pathname.startsWith("/api/")) {
      return new Response("not found\n", { status: 404 });
    }

    const id = await identify(request, env);
    if (id.error) return json(id, 503);

    if (url.pathname === "/api/whoami") return json(id);

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      const listed = await callIndex(env, id, "/list");
      // The index drops its own row when retention expires; the recording lives
      // in a different object and has to be told. Doing it here keeps the two
      // from drifting apart without a scheduled job -- the cost is one extra
      // call per expired task, on a listing that already happened.
      for (const gone of listed.expired || []) {
        try {
          await env.TASK.get(env.TASK.idFromName(taskName(id, gone))).fetch(
            new Request("https://task/forget", { method: "POST" }),
          );
        } catch {
          /* a recording that outlives its row is tidied on the next listing */
        }
      }
      delete listed.expired;
      return json(listed);
    }

    if (url.pathname === "/api/tasks" && request.method === "POST") {
      const spec = await request.json().catch(() => ({}));
      if (!spec.objective || !String(spec.objective).trim()) {
        return json({ error: "objective is required" }, 400);
      }

      // Both brakes live on the index, because it is the only object that can
      // see a user's tasks together. A refusal names the meter that refused.
      const admission = await callIndex(env, id, "/admit");
      if (!admission.ok) return json({ error: "refused", ...admission }, 429);

      // The id is minted here because it is part of the object's name, and the
      // task must carry the same one -- it ends up in the branch name, so a
      // second id generated inside the object would leave the branch pointing
      // at something the caller never saw.
      const taskId = crypto.randomUUID();
      const stub = env.TASK.get(env.TASK.idFromName(taskName(id, taskId)));
      const res = await stub.fetch(
        new Request("https://task/dispatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // owner comes from verified identity, never from the request body.
          body: JSON.stringify({ ...spec, id: taskId, owner: { tenant: id.tenant, user: id.user } }),
        }),
      );
      const body = await res.json();
      if (body.ok) {
        await callIndex(env, id, "/record", {
          id: taskId,
          objective: spec.objective,
          repo: spec.repo || null,
          branch: spec.branch || null,
          phase: "booting",
          createdAt: Date.now(),
        });
      }
      return json({ taskId, ...body }, res.status);
    }

    const match = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]{1,64})(\/.*)?$/);
    if (match) {
      const stub = env.TASK.get(env.TASK.idFromName(taskName(id, match[1])));
      const target = new URL((match[2] || "/state") + url.search, "https://task");
      return stub.fetch(new Request(target, request));
    }

    return new Response("not found\n", { status: 404 });
  },
};
