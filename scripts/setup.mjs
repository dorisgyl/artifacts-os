#!/usr/bin/env node
// `npm run setup`: everything the deploy button cannot do, in order.
// Safe to re-run. Nothing here touches Artifacts: the runtime creates its own
// repositories (rules, memory, experience, the template) on first use.

import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const wrangler = (args, input) => {
  const r = spawnSync("npx", ["wrangler", ...args], { input, encoding: "utf8", stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
};
const step = (n, s) => console.log("\n" + n + ". " + s);

step(1, "Checking tools");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error("Node 22.18 or newer is needed (TypeScript tests run without a build step). You have " + process.versions.node);
  process.exit(1);
}
const version = execFileSync("npx", ["wrangler", "--version"], { encoding: "utf8" }).match(/(\d+)\.(\d+)\.(\d+)/);
if (!version || Number(version[1]) < 4 || (Number(version[1]) === 4 && Number(version[2]) < 145)) {
  console.error("Wrangler 4.145 or newer is needed for the Artifacts binding. Run npm install.");
  process.exit(1);
}
const who = wrangler(["whoami"]);
if (!who.ok || /not authenticated/i.test(who.out)) {
  console.error("Log in first: npx wrangler login");
  process.exit(1);
}
console.log("   Node " + process.versions.node + ", Wrangler " + version[0] + ", logged in.");

step(2, "Deploying the runtime (Workers Paid plan needed: Artifacts, Dynamic Workers and Containers)");
const deploy = spawnSync("npx", ["wrangler", "deploy"], { stdio: "inherit" });
if (deploy.status !== 0) process.exit(deploy.status || 1);

step(3, "Secrets (press Enter to skip any of them)");
const secrets = [
  ["CF_ACCOUNT_ID", "Your account id, to route model calls through AI Gateway"],
  ["AI_GATEWAY_TOKEN", "An AI Gateway token (store provider keys at the gateway, not here)"],
  ["OPENAI_API_KEY", "Only if Codex in the container should call OpenAI directly"],
  ["OWNER_EMAIL", "Your Access email: only you may use this runtime"],
];
for (const [name, why] of secrets) {
  const value = process.env[name] || (await rl.question("   " + name + " — " + why + ": ")).trim();
  if (!value) continue;
  const r = wrangler(["secret", "put", name], value + "\n");
  console.log("   " + (r.ok ? "set " : "FAILED ") + name + (r.ok ? "" : ": " + r.out.slice(0, 200)));
}
console.log("   Model for edge agents: set MODEL in wrangler.jsonc (e.g. a provider/model name your gateway serves).");
console.log("   Without it, agents use FALLBACK_MODEL on Workers AI.");

step(4, "Put Cloudflare Access in front of it");
console.log(`   Dashboard → Workers & Pages → artifacts-os → Settings → Domains & Routes → enable Cloudflare Access.
   That protects workers.dev and every preview URL. For your own domain, add to wrangler.jsonc:
     "routes": [{ "pattern": "artifacts-os.<your-domain>", "custom_domain": true }]
   and create a self-hosted Access application for that hostname.`);

step(5, "Connect Claude Code (optional)");
console.log(`   Zero Trust → Access → Service credentials → create a service token, allow it in the
   Access policy, then (check \`claude mcp add --help\` for your version):
     claude mcp add --transport http artifacts-os https://<your-host>/mcp \\
       --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"`);

step(6, "Open the Console");
console.log("   Open your workers.dev URL (or your domain). The first visit creates rules, memory,");
console.log("   experience and tpl-scheduled-scan in Artifacts. Then type what you need.");
rl.close();
