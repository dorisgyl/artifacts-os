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

export async function approvalBar(env: Env, repo: string, branch: string, sha: string, runError: string | null) {
  const coord = coordinator(env, repo);
  const [lane, lanes, changed] = await Promise.all([
    coord.laneByBranch(branch),
    coord.lanes(),
    changedAgainstMain(env, repo, sha),
  ]);
  const review = (lane && (lane.review as ReviewResult | null)) || null;
  const decision = lane && (lane.decision as { by?: string; decision?: string; reason?: string } | null);
  const blocked = review && review.verdict === "reject";

  const versions = lanes
    .filter((l) => l.branch && ["pushed", "reviewing", "passed", "blocked"].includes(l.status))
    .map((l) => {
      const here = l.branch === branch;
      const tag = l.status === "blocked" ? " ✕" : l.status === "passed" ? " ✓" : "";
      return here
        ? `<b>${esc(l.branch)}${tag}</b>`
        : `<a href="/apps/${esc(repo)}/@${esc(refSegment(l.branch!))}/">${esc(l.branch)}${tag}</a>`;
    });
  versions.push(`<a href="/apps/${esc(repo)}/">main (live)</a>`);

  const files = changed
    .map((c) => `<li><code>${esc(c.type === "add" ? "+" : c.type === "delete" ? "−" : "~")} ${esc(c.path)}</code></li>`)
    .join("");
  const findings = review
    ? review.findings.length
      ? review.findings
          .map((f) => `<li>${esc(f.rule)}${f.path ? " · <code>" + esc(f.path) + (f.line ? ":" + f.line : "") + "</code>" : ""} — ${esc(f.detail)}</li>`)
          .join("")
      : `<li>all ${review.checked.length} rules pass</li>`
    : "<li>review pending</li>";

  return `<div id="aos-bar" style="position:sticky;top:0;z-index:99;font:13px/1.45 ui-sans-serif,system-ui,sans-serif;background:#111418;color:#e8eaed;border-bottom:3px solid ${blocked ? "#dc2626" : review ? "#16a34a" : "#d97706"};padding:10px 16px">
  <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:baseline;max-width:1100px;margin:0 auto">
    <strong style="font-size:14px">${esc(repo)} · ${esc(branch)}</strong>
    <span style="opacity:.75">${esc(sha.slice(0, 8))}${lane ? " · " + esc(lane.agent) : ""}</span>
    <span style="flex:1"></span>
    <span>${versions.join(" · ")}</span>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-width:1100px;margin:8px auto 0">
    <div><div style="opacity:.6">What changed</div><ul style="margin:4px 0;padding-left:16px">${files || "<li>nothing</li>"}</ul></div>
    <div><div style="opacity:.6">What the rules say</div><ul style="margin:4px 0;padding-left:16px">${findings}</ul></div>
    <div><div style="opacity:.6">Why</div><div style="margin-top:4px">${esc(lane?.strategy || "")}${lane?.detail ? "<br><span style='opacity:.75'>" + esc(lane.detail) + "</span>" : ""}${decision?.reason ? "<br><span style='opacity:.75'>" + esc(decision.by || "") + ": " + esc(decision.reason) + "</span>" : ""}${runError ? "<br><span style='color:#f87171'>preview run failed: " + esc(runError) + "</span>" : ""}</div></div>
    <div style="display:flex;align-items:flex-end;gap:8px">
      <input id="aos-reason" placeholder="Why this one (optional)" style="flex:1;min-width:0;background:#1d2127;color:inherit;border:1px solid #333a43;border-radius:6px;padding:6px 8px">
      <button id="aos-merge" ${blocked ? "disabled" : ""} style="background:${blocked ? "#3f3f46" : "#16a34a"};color:white;border:0;border-radius:6px;padding:7px 14px;font-weight:600;cursor:${blocked ? "not-allowed" : "pointer"}">Merge</button>
    </div>
  </div>
</div>
<script>
document.getElementById("aos-merge").addEventListener("click", async (e) => {
  e.target.disabled = true; e.target.textContent = "Merging…";
  const res = await fetch("/api/repos/${esc(repo)}/merge", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch: ${JSON.stringify(branch)}, reason: document.getElementById("aos-reason").value }) });
  const body = await res.json().catch(() => ({}));
  if (res.ok) location.href = "/apps/${esc(repo)}/";
  else { e.target.textContent = "Merge failed"; alert(body.error || res.status); }
});
</script>`;
}
