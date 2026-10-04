// The approval bar: review happens in the app, not in a diff view.
//
// A preview page carries a bar that says what changed (files and the agent's
// intent), what the rules review found, why (the decision notes), lets the
// owner switch between the competing versions in place, and merges. The data
// comes from the coordinator's live view of the same notes that are in Git.

import type { Env } from "../env.ts";
import { coordinator } from "../env.ts";
import { filesAt } from "./capability.ts";
import { headOf } from "../lib/artifacts.ts";
import { refSegment } from "./host.ts";
import type { ReviewResult } from "../rules/check.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function changedAgainstMain(env: Env, repo: string, sha: string) {
  const mainSha = await headOf(env, repo, "main");
  if (!mainSha) return [];
  const [a, b] = await Promise.all([filesAt(env, repo, mainSha), filesAt(env, repo, sha)]);
  const out: { path: string; type: "add" | "modify" | "delete" }[] = [];
  for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(p in a)) out.push({ path: p, type: "add" });
    else if (!(p in b)) out.push({ path: p, type: "delete" });
    else if (a[p] !== b[p]) out.push({ path: p, type: "modify" });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export async function previewPage(env: Env, repo: string, branch: string, sha: string, runError: string | null) {
  const coord = coordinator(env, repo);
  const [lane, lanes, changed] = await Promise.all([
    coord.laneByBranch(branch),
    coord.lanes(),
    changedAgainstMain(env, repo, sha),
  ]);
  const review = (lane && (lane.review as ReviewResult | null)) || null;
  const decision = lane && (lane.decision as { by?: string; decision?: string; reason?: string } | null);
  // The verdict counts only for the commit it was given for.
  const reviewed = !!(review && lane && lane.head === sha && (review as { sha?: string }).sha === sha);
  const passed = reviewed && review!.verdict === "pass";
  const blocked = reviewed && review!.verdict === "reject";
  const mergeable = passed && !!lane && lane.status === "passed";
  const stale = !!(review && lane && lane.head && lane.head !== sha);

  const versions = lanes
    .filter((l) => l.branch && ["pushed", "reviewing", "passed", "blocked"].includes(l.status))
    .map((l) => {
      const here = l.branch === branch;
      const tag = l.status === "blocked" ? " ✕" : l.status === "passed" ? " ✓" : "";
      return here
        ? `<b>${esc(l.branch)}${tag}</b>`
        : `<a href="/apps/${esc(repo)}/@${esc(refSegment(l.branch!))}/">${esc(l.branch)}${tag}</a>`;
    });
  versions.push(`<a href="/apps/${esc(repo)}/" target="_top">main (live)</a>`);

  const files = changed
    .map((c) => `<li><code>${esc(c.type === "add" ? "+" : c.type === "delete" ? "−" : "~")} ${esc(c.path)}</code></li>`)
    .join("");
  const findings = !review || !reviewed
    ? `<li>${stale ? "this version has not been reviewed yet (the branch moved)" : "review pending"}</li>`
    : review.findings.length
      ? review.findings
          .map((f) => `<li>${esc(f.rule)}${f.path ? " · <code>" + esc(f.path) + (f.line ? ":" + f.line : "") + "</code>" : ""} — ${esc(f.detail)}</li>`)
          .join("")
      : `<li>all ${review.checked.length} rules pass</li>`;
  const accent = blocked ? "#dc2626" : passed ? "#16a34a" : "#d97706";
  const frame = "/apps/" + encodeURIComponent(repo) + "/@" + sha + "/-/";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(repo)} · ${esc(branch)}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; background: #111418; }
  #bar { color: #e8eaed; border-bottom: 3px solid ${accent}; padding: 10px 16px; }
  #bar a { color: #93b4ff; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: baseline; max-width: 1100px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; max-width: 1100px; margin: 8px auto 0; }
  .k { opacity: .6; } ul { margin: 4px 0; padding-left: 16px; }
  input { flex: 1; min-width: 0; background: #1d2127; color: inherit; border: 1px solid #333a43; border-radius: 6px; padding: 6px 8px; font: inherit; }
  button { border: 0; border-radius: 6px; padding: 7px 14px; font-weight: 600; color: white; background: #16a34a; cursor: pointer; font: inherit; }
  button:disabled { background: #3f3f46; cursor: not-allowed; }
  iframe { flex: 1; border: 0; width: 100%; background: white; }
</style></head><body>
<div id="bar">
  <div class="row">
    <strong style="font-size:14px">${esc(repo)} · ${esc(branch)}</strong>
    <span class="k">${esc(sha.slice(0, 8))}${lane ? " · " + esc(lane.agent) : ""}</span>
    <span style="flex:1"></span>
    <span>${versions.join(" · ")}</span>
  </div>
  <div class="grid">
    <div><div class="k">What changed</div><ul>${files || "<li>nothing</li>"}</ul></div>
    <div><div class="k">What the rules say</div><ul>${findings}</ul></div>
    <div><div class="k">Why</div><div style="margin-top:4px">${esc(lane?.strategy || "")}${lane?.detail ? "<br><span class='k'>" + esc(lane.detail) + "</span>" : ""}${decision?.reason ? "<br><span class='k'>" + esc(decision.by || "") + ": " + esc(decision.reason) + "</span>" : ""}${runError ? "<br><span style='color:#f87171'>preview run failed: " + esc(runError) + "</span>" : ""}</div></div>
    <form id="merge" style="display:flex;align-items:flex-end;gap:8px" data-repo="${esc(repo)}" data-branch="${esc(branch)}" data-sha="${esc(sha)}">
      <input name="reason" placeholder="Why this one (optional)" aria-label="Why this one">
      <button ${mergeable ? "" : "disabled"}>${lane && lane.status === "merged" ? "Merged" : "Merge"}</button>
    </form>
  </div>
</div>
<iframe src="${esc(frame)}" sandbox="allow-scripts" title="${esc(repo)} at ${esc(sha.slice(0, 8))}"></iframe>
<script>
document.getElementById("merge").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget, b = f.querySelector("button");
  b.disabled = true; b.textContent = "Merging…";
  const res = await fetch("/api/repos/" + encodeURIComponent(f.dataset.repo) + "/merge", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch: f.dataset.branch, sha: f.dataset.sha, reason: f.reason.value }) });
  const body = await res.json().catch(() => ({}));
  if (res.ok) location.href = "/apps/" + encodeURIComponent(f.dataset.repo) + "/";
  else { b.textContent = "Not merged: " + (body.error || res.status); }
});
</script></body></html>`;
}
