// AgentRun: one edge agent, start to finish, as a Workflow.
//
//   tokens -> claim -> propose -> smoke -> (retry once) -> push
//
// Each step is retried by the platform and visible in the dashboard. The agent
// talks to the others only through Git: it reads their intent notes before
// choosing a direction, writes its own claim before doing the work, and
// pushes its branch and its notes together. Its live state goes to the
// coordinator, never into a commit.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { coordinator, registry } from "../env.ts";
import { WorkingCopy, agentAuthor } from "../git/ops.ts";
import { writeNotes, notesRef, parseNotesRef } from "../git/notes.ts";
import { readTreeFiles, readText, headOf } from "../lib/artifacts.ts";
import { propose, DEFAULT_SYSTEM, type Proposal } from "./edge.ts";
import { runApp } from "../apps/host.ts";
import { reviewRef } from "./review.ts";
import type { Strategy } from "../control/planner.ts";

export interface AgentRunParams {
  repo: string;
  agent: string;
  branch: string;
  task: string;
  allowed: string[];
  strategy?: Strategy;
  target?: "app" | "template";
  /** For a template fix: the app where the problem was found. */
  origin?: string;
  extraContext?: string;
}

const TTL = 15 * 60;

export class AgentRun extends WorkflowEntrypoint<Env, AgentRunParams> {
  async run(event: Readonly<WorkflowEvent<AgentRunParams>>, step: WorkflowStep) {
    const p = event.payload;
    const coord = coordinator(this.env, p.repo);
    try {
      return await this.work(p, step);
    } catch (e) {
      await coord.laneEvent(p.agent, "failed", String((e as Error).message || e).slice(0, 300));
      throw e;
    }
  }

  private async work(p: AgentRunParams, step: WorkflowStep) {
    const env = this.env;
    const coord = coordinator(env, p.repo);

    const remotes = await step.do("tokens", async () => {
      const r = await coord.issue(p.repo, p.agent, [{ repo: p.repo, scope: "write" }], TTL);
      return JSON.parse(JSON.stringify(r)) as Record<string, { url: string; token: string }>;
    });
    const remote = remotes[p.repo];

    // Claim: read what the others intend, then say what this agent will do,
    // before doing any of it.
    const claim = await step.do("claim", async () => {
      const wc = await WorkingCopy.clone(remote, { ref: "main" });
      const base = await wc.resolve("main");
      const refs = await wc.listRemoteRefs(remote, "refs/notes/intent/");
      const others: { agent: string; direction: string; status: string }[] = [];
      for (const r of refs) {
        const parsed = parseNotesRef(r.ref);
        if (!parsed || parsed.writer === p.agent) continue;
        await wc.fetchRef(remote, r.ref, r.ref);
        const text = await wc.readNote(r.ref, base);
        if (!text) continue;
        try {
          const n = JSON.parse(text);
          others.push({ agent: parsed.writer, direction: n.direction || "", status: n.status || "" });
        } catch {
          others.push({ agent: parsed.writer, direction: text.slice(0, 200), status: "?" });
        }
      }
      const direction = p.strategy ? p.strategy.summary : p.task.split("\n").pop()!.slice(0, 200);
      await writeNotes(
        wc,
        remote,
        [
          {
            kind: "intent",
            writer: p.agent,
            oid: base,
            body: {
              v: 1,
              agent: p.agent,
              status: "claimed",
              direction,
              strategy: p.strategy?.id,
              branch: p.branch,
              to: "all",
              at: new Date().toISOString(),
            },
          },
        ],
        agentAuthor(p.agent),
      );
      await coord.laneEvent(p.agent, "claimed", direction, { branch: p.branch });
      return { base, others };
    });

    const context = await step.do("read", async () => {
      const files = await readTreeFiles(env, p.repo, claim.base, (path) => !/\.(pdf|png|jpe?g)$/i.test(path));
      const memory: Record<string, string> = {};
      for (const m of ["cards.json", "merchant-aliases.json", "preferences.json"]) {
        const t = await readText(env, "memory", "main", m);
        if (t) memory[m] = t;
      }
      // A template fix sees the statement that exposed the problem.
      if (p.origin) {
        const originSha = await headOf(env, p.origin, "main");
        if (originSha) {
          const originFiles = await readTreeFiles(env, p.origin, originSha, (x) => x.startsWith("data/statements/") && /\.(csv|md)$/.test(x));
          Object.assign(files, originFiles);
        }
      }
      const system = (await readText(env, "experience", "main", "prompts/edge-agent.md")) || DEFAULT_SYSTEM;
      return { files, memory, system };
    });

    const started = Date.now();
    let attempts = 0;
    let lastError: string | undefined;
    let accepted: { proposal: Proposal; model: string; tokensIn?: number; tokensOut?: number } | null = null;

    for (let i = 0; i < 2 && !accepted; i++) {
      attempts++;
      const out = await step.do("propose-" + i, { retries: { limit: 1, delay: "5 seconds" } }, async () => {
        await coord.laneEvent(p.agent, "started", i ? "retrying after: " + lastError : "writing code");
        const r = await propose(
          env,
          {
            repo: p.repo,
            agent: p.agent,
            task: p.task,
            strategy: p.strategy,
            allowed: p.allowed,
            files: context.files,
            memory: context.memory,
            others: claim.others,
            previousError: lastError,
            extraContext: p.extraContext,
          },
          context.system,
        );
        return { proposal: r.proposal, model: r.completion.model, tokensIn: r.completion.tokensIn, tokensOut: r.completion.tokensOut };
      });

      // Smoke test: run the app with the proposed files, without pushing.
      // Templates are not runnable apps on their own, so they skip this.
      const smoke = await step.do("smoke-" + i, async () => {
        if (p.target === "template" || !context.files["src/main.js"]) return { ok: true as const };
        const overlay: Record<string, string> = {};
        for (const f of out.proposal.files) overlay[f.path] = f.content;
        try {
          const r = await runApp(env, this.ctx.exports, p.repo, { sha: claim.base, mode: "smoke", overlay });
          return { ok: true as const, summary: r.result.summary };
        } catch (e) {
          return { ok: false as const, error: String((e as Error).message || e).slice(0, 1500) };
        }
      });
      if (smoke.ok) accepted = out;
      else lastError = smoke.error;
    }
    if (!accepted) {
      await coord.laneEvent(p.agent, "failed", "smoke test failed twice: " + lastError);
      return { ok: false, error: lastError };
    }

    const pushed = await step.do("push", async () => {
      const wc = await WorkingCopy.clone(remote, { ref: "main" });
      await wc.checkout(claim.base, { create: p.branch });
      for (const f of accepted!.proposal.files) await wc.write(f.path, f.content);
      const head = await wc.commit(accepted!.proposal.commit, agentAuthor(p.agent));
      await wc.push(remote, p.branch, { force: true });
      await writeNotes(
        wc,
        remote,
        [
          {
            kind: "intent",
            writer: p.agent,
            oid: head,
            body: {
              v: 1,
              agent: p.agent,
              status: "pushed",
              direction: accepted!.proposal.intent,
              strategy: p.strategy?.id,
              branch: p.branch,
              to: "all",
              at: new Date().toISOString(),
            },
          },
          {
            kind: "telemetry",
            writer: p.agent,
            oid: head,
            body: {
              v: 1,
              agent: p.agent,
              model: accepted!.model,
              tokensIn: accepted!.tokensIn,
              tokensOut: accepted!.tokensOut,
              ms: Date.now() - started,
              attempts,
            },
          },
        ],
        agentAuthor(p.agent),
      );
      await coord.laneEvent(p.agent, "pushed", accepted!.proposal.intent, { head });
      await registry(env).meter("agentRuns", 1);
      return { head };
    });

    // With push events available the ReviewOnPush workflow picks this up. The
    // fallback (D1 item 3) is to review here, directly.
    if ((env as Env & { REVIEW_MODE?: string }).REVIEW_MODE === "direct") {
      await step.do("review", async () => {
        const r = await reviewRef(env, p.repo, p.branch, pushed.head);
        return { verdict: r.verdict };
      });
    }
    return { ok: true, head: pushed.head, branch: p.branch, notes: notesRef("intent", p.agent) };
  }
}
