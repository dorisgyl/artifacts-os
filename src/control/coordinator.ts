// RepoCoordinator: one Durable Object per repository.
//
// It owns what must not go into Git because it changes every second, and what
// must be decided in one place:
//
//   - lanes: which agents are working on this repo, on which branch, in what
//     state. The durable record of the same facts is the agents' intent notes;
//     this is the live view the Console renders.
//   - tokens: every token an agent is given for this repo is minted, recorded
//     and revoked here. Agents never mint their own.
//   - the expected `main`: Artifacts tokens are per repo, not per branch, so
//     nothing in the platform stops a write token from moving main. The review
//     workflow compares every push to main with this value and puts main back
//     if they differ (the main guard).
//   - waiters: a workflow that fanned out agents parks on an event; the last
//     lane to finish sends it.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { registry } from "../env.ts";
import { remoteFor, revoke } from "../lib/artifacts.ts";
import type { Remote } from "../git/ops.ts";
import type { Json } from "../lib/json.ts";

export type LaneKind = "edge" | "external" | "container" | "merge";
export type LaneStatus =
  | "queued"
  | "claimed"
  | "started"
  | "pushed"
  | "reviewing"
  | "passed"
  | "blocked"
  | "merged"
  | "archived"
  | "done"
  | "failed";

export interface Lane {
  agent: string;
  kind: LaneKind;
  branch: string | null;
  strategy: string | null;
  status: LaneStatus;
  detail: string | null;
  head: string | null;
  review: Json;
  decision: Json;
  startedAt: number;
  updatedAt: number;
  workspace: string | null;
}

interface Waiter {
  id: string;
  workflow: "NEW_APP" | "FAN_OUT";
  instanceId: string;
  agents: string[];
  until: LaneStatus[];
}

const TERMINAL: LaneStatus[] = ["passed", "blocked", "merged", "archived", "done", "failed"];

export class RepoCoordinator extends DurableObject<Env> {
  private repoName: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS lanes (agent TEXT PRIMARY KEY, kind TEXT, branch TEXT, strategy TEXT," +
          "status TEXT, detail TEXT, head TEXT, review TEXT, decision TEXT, startedAt INTEGER, updatedAt INTEGER," +
          "workspace TEXT)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, repo TEXT, scope TEXT, agent TEXT," +
          "expiresAt TEXT, revoked INTEGER DEFAULT 0)",
      );
      sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
      this.repoName = (await this.ctx.storage.get<string>("repo")) || null;
    });
  }

  private async bind(repo: string) {
    if (this.repoName !== repo) {
      this.repoName = repo;
      await this.ctx.storage.put("repo", repo);
    }
  }

  private kvGet<T>(k: string): T | null {
    const r = this.ctx.storage.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return r ? (JSON.parse(r.v as string) as T) : null;
  }

  private kvSet(k: string, v: unknown) {
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      JSON.stringify(v),
    );
  }

  private row(agent: string): Lane | null {
    const r = this.ctx.storage.sql.exec("SELECT * FROM lanes WHERE agent = ?", agent).toArray()[0];
    if (!r) return null;
    return {
      ...(r as unknown as Lane),
      review: r.review ? JSON.parse(r.review as string) : null,
      decision: r.decision ? JSON.parse(r.decision as string) : null,
    };
  }

  // ---- lanes -------------------------------------------------------------

  async startLane(
    repo: string,
    lane: { agent: string; kind: LaneKind; branch?: string | null; strategy?: string | null; workspace?: string | null },
  ): Promise<Lane> {
    await this.bind(repo);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO lanes (agent, kind, branch, strategy, status, startedAt, updatedAt, workspace) " +
        "VALUES (?, ?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT(agent) DO UPDATE SET kind=excluded.kind, " +
        "branch=excluded.branch, strategy=excluded.strategy, status='queued', detail=NULL, review=NULL, " +
        "decision=NULL, startedAt=excluded.startedAt, updatedAt=excluded.updatedAt, workspace=excluded.workspace",
      lane.agent,
      lane.kind,
      lane.branch || null,
      lane.strategy || null,
      now,
      now,
      lane.workspace || null,
    );
    await this.publish(lane.agent, "lane", "queued", lane.strategy || lane.branch || undefined);
    return this.row(lane.agent)!;
  }

  async laneEvent(
    agent: string,
    status: LaneStatus,
    detail?: string,
    extra: { head?: string; review?: Json; decision?: Json; branch?: string } = {},
  ): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE lanes SET status = ?, detail = COALESCE(?, detail), head = COALESCE(?, head)," +
        "review = COALESCE(?, review), decision = COALESCE(?, decision), branch = COALESCE(?, branch), updatedAt = ? " +
        "WHERE agent = ?",
      status,
      detail ?? null,
      extra.head ?? null,
      extra.review === undefined ? null : JSON.stringify(extra.review),
      extra.decision === undefined ? null : JSON.stringify(extra.decision),
      extra.branch ?? null,
      now,
      agent,
    );
    await this.publish(agent, "lane", status, detail, extra);
    if (TERMINAL.includes(status)) {
      await this.revokeAgent(agent);
      await this.checkWaiters();
    }
  }

  async lanes(): Promise<Lane[]> {
    return this.ctx.storage.sql
      .exec("SELECT agent FROM lanes ORDER BY startedAt")
      .toArray()
      .map((r) => this.row(r.agent as string)!);
  }

  async laneByBranch(branch: string): Promise<Lane | null> {
    const r = this.ctx.storage.sql
      .exec("SELECT agent FROM lanes WHERE branch = ? ORDER BY updatedAt DESC LIMIT 1", branch)
      .toArray()[0];
    return r ? this.row(r.agent as string) : null;
  }

  async laneByWorkspace(workspace: string): Promise<Lane | null> {
    const r = this.ctx.storage.sql
      .exec("SELECT agent FROM lanes WHERE workspace = ? ORDER BY updatedAt DESC LIMIT 1", workspace)
      .toArray()[0];
    return r ? this.row(r.agent as string) : null;
  }

  async lane(agent: string): Promise<Lane | null> {
    return this.row(agent);
  }

  // ---- tokens ------------------------------------------------------------

  /**
   * Mint the tokens one agent needs, all short-lived and all recorded here so
   * they can be revoked the moment the lane ends.
   */
  async issue(
    repo: string,
    agent: string,
    grants: { repo: string; scope: "read" | "write" }[],
    ttlSeconds: number,
  ): Promise<Record<string, Remote>> {
    await this.bind(repo);
    const out: Record<string, Remote> = {};
    for (const g of grants) {
      const r = await remoteFor(this.env, g.repo, g.scope, ttlSeconds);
      this.ctx.storage.sql.exec(
        "INSERT INTO tokens (id, repo, scope, agent, expiresAt) VALUES (?, ?, ?, ?, ?)",
        r.tokenId,
        g.repo,
        g.scope,
        agent,
        r.expiresAt,
      );
      out[g.repo] = { url: r.url, token: r.token };
    }
    return out;
  }

  async revokeAgent(agent: string): Promise<number> {
    const rows = this.ctx.storage.sql
      .exec("SELECT id, repo FROM tokens WHERE agent = ? AND revoked = 0", agent)
      .toArray();
    for (const t of rows) await revoke(this.env, t.repo as string, t.id as string);
    this.ctx.storage.sql.exec("UPDATE tokens SET revoked = 1 WHERE agent = ?", agent);
    return rows.length;
  }

  // ---- main guard --------------------------------------------------------

  /**
   * Record the commit the runtime is about to move main to. Called before the
   * push, so the review of that push never mistakes it for a foreign one; the
   * last few values are kept because a push can fail after this call.
   */
  async expectMain(repo: string, sha: string): Promise<void> {
    await this.bind(repo);
    const recent = (this.kvGet<string[]>("expectedMainRecent") || []).filter((s) => s !== sha);
    recent.unshift(sha);
    this.kvSet("expectedMainRecent", recent.slice(0, 5));
    this.kvSet("expectedMain", sha);
  }

  async expectedMain(): Promise<string | null> {
    return this.kvGet<string>("expectedMain");
  }

  async isExpectedMain(sha: string): Promise<boolean> {
    const recent = this.kvGet<string[]>("expectedMainRecent");
    // A repo the runtime has never moved main on has nothing to guard yet.
    return !recent || recent.includes(sha);
  }

  // ---- waiters -----------------------------------------------------------

  async waitFor(w: Omit<Waiter, "id">): Promise<void> {
    const waiters = this.kvGet<Waiter[]>("waiters") || [];
    waiters.push({ ...w, id: crypto.randomUUID() });
    this.kvSet("waiters", waiters);
    await this.checkWaiters();
  }

  private async checkWaiters() {
    const waiters = this.kvGet<Waiter[]>("waiters") || [];
    if (!waiters.length) return;
    const keep: Waiter[] = [];
    for (const w of waiters) {
      const lanes = w.agents.map((a) => this.row(a));
      const done = lanes.every((l) => l && w.until.includes(l.status));
      if (!done) {
        keep.push(w);
        continue;
      }
      const binding = w.workflow === "NEW_APP" ? this.env.NEW_APP : this.env.FAN_OUT;
      try {
        const inst = await binding.get(w.instanceId);
        await inst.sendEvent({ type: "lanes-done", payload: { lanes: JSON.parse(JSON.stringify(lanes)) } });
      } catch {
        keep.push(w); // try again on the next lane event
      }
    }
    this.kvSet("waiters", keep);
  }

  // ---- run snapshots -------------------------------------------------------
  // An app hands its results to the runtime, which commits them for a live
  // run and only shows them for a preview. Staged here because the app's
  // capability and the code that commits are separate invocations.

  async stage(runId: string, name: string, value: Json): Promise<void> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS staged (runId TEXT, name TEXT, value TEXT, at INTEGER, PRIMARY KEY (runId, name))",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO staged (runId, name, value, at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(runId, name) DO UPDATE SET value = excluded.value, at = excluded.at",
      runId,
      name,
      JSON.stringify(value),
      Date.now(),
    );
    // Previews are re-run on every page view; keep an hour of them.
    this.ctx.storage.sql.exec("DELETE FROM staged WHERE at < ?", Date.now() - 3600000);
  }

  async staged(runId: string): Promise<Record<string, Json>> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS staged (runId TEXT, name TEXT, value TEXT, at INTEGER, PRIMARY KEY (runId, name))",
    );
    const out: Record<string, Json> = {};
    for (const r of this.ctx.storage.sql.exec("SELECT name, value FROM staged WHERE runId = ?", runId).toArray()) {
      out[r.name as string] = JSON.parse(r.value as string);
    }
    return out;
  }

  // ---- hub ---------------------------------------------------------------

  private async publish(agent: string, kind: string, status: string, detail?: string, data?: Json) {
    try {
      await registry(this.env).publish({
        at: Date.now(),
        repo: this.repoName || "?",
        agent,
        kind,
        status,
        detail,
        data,
      });
    } catch {
      /* the hub is a view; the lane row is the record */
    }
  }

  async note(kind: string, detail: string, data?: Json): Promise<void> {
    await this.publish("runtime", kind, kind, detail, data);
  }
}
