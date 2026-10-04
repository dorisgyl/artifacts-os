// MCP: how an outside agent joins.
//
// Three tools, and only one of them does real work: open_workspace hands the
// agent its own fork of an app, a one-hour write token for that fork, read
// tokens for the app, the rules and the memory, and the AGENTS.md contract.
// From there it is plain Git -- clone, commit, write an intent note, push.
// The push event brings the work back for review, exactly as for the runtime's
// own agents. MCP gives out keys; Git is the interface.
//
// Transport: Streamable HTTP, stateless, JSON responses (POST /mcp).

import type { Env } from "../env.ts";
import { coordinator } from "../env.ts";
import { withRepo, waitReady, workspaceName, readText } from "../lib/artifacts.ts";
import { registry } from "../env.ts";
import { ensureSeeds } from "../control/setup.ts";
import { secretOf } from "../git/ops.ts";
import { refSegment } from "../apps/host.ts";

const PROTOCOL = "2025-06-18";

// Lane ids the runtime itself uses; an outside agent may not take them.
const RESERVED = /^(edge-|attempt-|change-|fix-|merge-|git:|codex-container$|runtime$|rules-auditor$|importer$|guard$|owner$|mirror$|jev$|rules$|planner$|app$)/;

const TOOLS = [
  {
    name: "request_app",
    description: "Ask the owner's runtime to build a new personal app from one sentence. Returns the workflow id; progress shows in the Console.",
    inputSchema: {
      type: "object",
      properties: { need: { type: "string", description: "What the app should do, in one sentence." } },
      required: ["need"],
    },
  },
  {
    name: "open_workspace",
    description:
      "Get your own fork of an existing app to work in, with a short-lived write token for the fork and read-only access to the app, the owner's rules and memory. Work with plain git; push a branch to your fork and it is brought back for review.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "App repository name, e.g. card-watch." },
        intent: { type: "string", description: "One sentence: what you are going to do." },
        agent: { type: "string", description: "Your agent id, used for your notes ref. Default: claude-code." },
      },
      required: ["app", "intent"],
    },
  },
  {
    name: "status",
    description: "Lanes, review verdicts and preview links for an app.",
    inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
  },
];

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const text = (t: string) => ({ content: [{ type: "text", text: t }] });

async function callTool(env: Env, origin: string, name: string, args: Record<string, unknown>) {
  if (name === "request_app") {
    const need = String(args.need || "").trim();
    if (!need) throw new Error("need is required");
    await ensureSeeds(env);
    const inst = await env.NEW_APP.create({ params: { need } });
    return text("Started. Workflow " + inst.id + ". Watch it in the Console: " + origin + "/");
  }

  if (name === "open_workspace") {
    const app = String(args.app || "");
    const intent = String(args.intent || "").slice(0, 300);
    const agent = String(args.agent || "claude-code").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32).toLowerCase();
    // Only the owner's apps, and never a name the runtime's own agents use.
    if (!(await registry(env).app(app))) throw new Error("no app named " + app);
    if (RESERVED.test(agent)) throw new Error("agent id '" + agent + "' is reserved; pick another");

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
    const ws = workspaceName(app, agent, id);
    await withRepo(env, app, (r) => r.fork(ws, { description: agent + ": " + intent }));
    await waitReady(env, ws);

    const coord = coordinator(env, app);
    await coord.startLane(app, { agent, kind: "external", strategy: intent, workspace: ws });
    await coord.laneEvent(agent, "claimed", intent);
    const remotes = await coord.issue(app, agent, [
      { repo: ws, scope: "write" },
      { repo: app, scope: "read" },
      { repo: "rules", scope: "read" },
      { repo: "memory", scope: "read" },
    ], 3600);
    const agentsMd = (await readText(env, app, "main", "AGENTS.md")) || "";
    const url = (r: { url: string; token: string }) => r.url.replace("https://", "https://x:" + secretOf(r.token) + "@");

    return text(
      [
        "Workspace ready: " + ws + " (a fork of " + app + "; yours alone; tokens expire in one hour).",
        "",
        "Clone and work with plain git:",
        "  git clone " + url(remotes[ws]) + " " + app,
        "  cd " + app + " && git checkout -b <your-branch>",
        "",
        "Before you change anything, claim your direction as a note (other agents read these):",
        "  git notes --ref=refs/notes/intent/" + agent + " add -m '{\"v\":1,\"agent\":\"" + agent + "\",\"status\":\"claimed\",\"direction\":\"" + intent.replace(/'/g, "") + "\",\"to\":\"all\"}' HEAD",
        "",
        "When done: one-line commit, update your intent note on the new commit (status \"pushed\"), then push the note first and the branch second:",
        "  git push -f origin refs/notes/intent/" + agent + " && git push origin <your-branch>",
        "",
        "The push is reviewed against the owner's rules automatically; the owner previews it in the app and merges.",
        "",
        "Read-only, for context:",
        "  app:    " + url(remotes[app]),
        "  rules:  " + url(remotes["rules"]),
        "  memory: " + url(remotes["memory"]),
        "",
        "----- AGENTS.md (" + app + ") -----",
        agentsMd,
      ].join("\n"),
    );
  }

  if (name === "status") {
    const app = String(args.app || "");
    const lanes = await coordinator(env, app).lanes();
    const lines = lanes.map((l) => {
      const v = l.review as { verdict?: string } | null;
      return (
        "- " + l.agent + " [" + l.status + "]" + (l.branch ? " " + l.branch : "") +
        (v && v.verdict ? " review: " + v.verdict : "") +
        (l.branch ? "  preview: " + origin + "/apps/" + app + "/@" + refSegment(l.branch) + "/" : "")
      );
    });
    return text(app + " — live: " + origin + "/apps/" + app + "/\n" + (lines.join("\n") || "no lanes"));
  }

  throw new Error("unknown tool " + name);
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    // No server-initiated stream in a stateless server.
    return new Response("method not allowed", { status: 405 });
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const origin = new URL(request.url).origin;
  let body: RpcRequest | RpcRequest[];
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const batch = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of batch) {
    const reply = await handleOne(env, origin, msg);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

export async function handleOne(env: Env, origin: string, msg: RpcRequest) {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  try {
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "artifacts-os", version: "0.1.0" },
            instructions:
              "Artifacts-OS runs a person's own agent and apps. To change an app, call open_workspace and then use plain git in the fork you get back.",
          },
        };
      case "notifications/initialized":
        return null;
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const name = String(msg.params?.name || "");
        const args = (msg.params?.arguments || {}) as Record<string, unknown>;
        try {
          return { jsonrpc: "2.0", id, result: await callTool(env, origin, name, args) };
        } catch (e) {
          return { jsonrpc: "2.0", id, result: { ...text(String((e as Error).message || e)), isError: true } };
        }
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + msg.method } };
    }
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: String((e as Error).message || e) } };
  }
}

export { TOOLS };
