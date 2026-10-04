// Entry point. The runtime loads this module as a Dynamic Worker and calls:
//   fetch(request)          -- to serve the report page
//   run({ now, mode })      -- on schedule, on "Run now", and as a smoke test
// Template code: change it in the template repository, not in an app.

import { WorkerEntrypoint } from "cloudflare:workers";
import { openRepo } from "./runtime/repo.js";
import { runPipeline } from "./pipeline.js";
import { renderPage } from "./report-shell.js";
import { renderReport } from "./report.js";

export default class App extends WorkerEntrypoint {
  async fetch(request) {
    const repo = openRepo(this.env);
    const url = new URL(request.url);
    const name = (await repo.readJson("app.json"))?.name || "app";

    if (url.pathname.endsWith("/snapshot.json")) {
      const latest = await repo.readJson("snapshots/latest.json");
      return Response.json(latest || {});
    }

    const latest = await repo.readJson("snapshots/latest.json");
    const body = latest
      ? renderReport(latest)
      : "<p>No report yet. Upload statements in the Console and press <b>Run now</b>.</p>";
    return new Response(renderPage({ title: name, body }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  async run(opts = {}) {
    const repo = openRepo(this.env);
    const now = opts.now ? new Date(opts.now) : new Date();
    const result = await runPipeline(repo, { now, mode: opts.mode || "manual" });
    await repo.writeSnapshot("latest.json", result);
    if (result.period) await repo.writeSnapshot(result.period + ".json", result);
    await repo.log({ kind: "run", detail: result.summary });
    return { ok: true, period: result.period, summary: result.summary, findings: result.findings.length };
  }
}
