#!/usr/bin/env node
// Publish one Artifacts repository -- every branch, tag and notes ref -- to a
// public Git remote, so anyone can clone it and read the agents' notes:
//
//   npm run mirror -- <runtime url> <repo> <public remote>
//   e.g. npm run mirror -- https://artifacts-os.nevoflux.app card-watch \
//          https://github.com/dorisgyl/artifacts-os-demo-card-watch.git
//
// Behind Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (a service
// token). Agent trace notes are dropped before publishing (refs/notes/trace/*):
// they hold prompts and outputs, and app repos are private by default.
// Everything else is published as it is -- including data/statements/. That is
// fine for the simulated demo data; never mirror a repo with real statements.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [runtime, repo, target] = process.argv.slice(2);
if (!runtime || !repo || !target) {
  console.error("usage: npm run mirror -- <runtime url> <repo> <public git remote>");
  process.exit(2);
}
const headers = { "content-type": "application/json" };
if (process.env.CF_ACCESS_CLIENT_ID) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET || "";
}
const res = await fetch(runtime.replace(/\/$/, "") + "/api/repos/" + encodeURIComponent(repo) + "/read-token", { method: "POST", headers });
if (!res.ok) {
  console.error("could not get a read token: " + res.status + " " + (await res.text()).slice(0, 300));
  process.exit(1);
}
const { url, token } = await res.json();
const secret = token.split("?expires=")[0];
const authed = url.replace("https://", "https://x:" + encodeURIComponent(secret) + "@");

const dir = mkdtempSync(join(tmpdir(), "aos-mirror-"));
const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] }).toString();
try {
  git("clone", "--mirror", "--quiet", authed, ".");
  git("remote", "set-url", "origin", url); // no token left in the mirror's config
  for (const ref of git("for-each-ref", "--format=%(refname)", "refs/notes/trace/").split("\n").filter(Boolean)) {
    git("update-ref", "-d", ref);
  }
  const notes = git("for-each-ref", "--format=%(refname)", "refs/notes/").split("\n").filter(Boolean);
  git("push", "--mirror", target);
  console.log("mirrored " + repo + " to " + target + " (" + notes.length + " notes refs)");
  console.log("read it with:\n  git clone " + target + " && cd " + repo + "\n  git fetch origin 'refs/notes/*:refs/notes/*'\n  git log --notes='refs/notes/*'");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
