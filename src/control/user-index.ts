// The registry: one object per owner, named `tenant/<t>/user/<u>`.
//
// It began as codex-cloud's per-user task index -- the only place that sees a
// user's container tasks together, so the only place the two brakes
// (concurrency and daily spend) can be applied. Artifacts-OS keeps that role
// and adds three more that need the same "sees everything" position:
//
//   - the app table: which personal apps exist, their template version, their
//     schedule and the commit `main` is expected to be at;
//   - the meters shown in the Console: agent runs, containers, container time;
//   - the event hub: every lane event from every repo, broadcast to the Console
//     and kept as an exportable timeline. Live progress never goes into Git.

import { DurableObject } from "cloudflare:workers";
import { nextRun } from "../lib/cron.ts";
import type { Json } from "../lib/json.ts";

interface Limits {
  maxConcurrent: number;
  containerSecondsPerDay: number;
  turnsPerDay: number;
  retentionDays: number;
}

const DEFAULTS: Limits = {
  // One task is one container, so this is the first thing between a user and
  // the deployment-wide container ceiling.
  maxConcurrent: 3,
  // Container seconds are the only expensive resource this project owns.
  containerSecondsPerDay: 4 * 60 * 60,
  turnsPerDay: 200,
  retentionDays: 14,
};

const EVENTS_KEPT = 5000;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface AppRow {
  name: string;
  need: string;
  template: string;
  templateVersion: string;
  schedule: string | null;
  mainSha: string | null;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastReport: string | null;
}

export interface HubEvent {
  at: number;
  repo: string;
  agent?: string;
  kind: string;
  status?: string;
  detail?: string;
  data?: Json;
}

type IndexEnv = {
  LIMIT_CONCURRENT_TASKS?: string;
  LIMIT_CONTAINER_SECONDS_PER_DAY?: string;
  LIMIT_TURNS_PER_DAY?: string;
  TASK_RETENTION_DAYS?: string;
};

export class UserIndex extends DurableObject<IndexEnv> {
  constructor(ctx: DurableObjectState, env: IndexEnv) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS tasks (" +
          "id TEXT PRIMARY KEY, objective TEXT, repo TEXT, branch TEXT," +
          "phase TEXT, goalStatus TEXT, stopReason TEXT," +
          "createdAt INTEGER, updatedAt INTEGER, stoppedAt INTEGER," +
          "containerSeconds INTEGER DEFAULT 0, turns INTEGER DEFAULT 0)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS usage (" +
          "day TEXT PRIMARY KEY, containerSeconds INTEGER DEFAULT 0, turns INTEGER DEFAULT 0)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS apps (" +
          "name TEXT PRIMARY KEY, need TEXT, template TEXT, templateVersion TEXT, schedule TEXT," +
          "mainSha TEXT, createdAt INTEGER, lastRunAt INTEGER, nextRunAt INTEGER, lastReport TEXT)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS meters (" +
          "day TEXT, kind TEXT, n INTEGER DEFAULT 0, PRIMARY KEY (day, kind))",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS events (" +
          "seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, repo TEXT, agent TEXT," +
          "kind TEXT, status TEXT, detail TEXT, data TEXT)",
      );
    });
  }

  // ---- container brakes (unchanged from codex-cloud) ---------------------

  limits(): Limits {
    const num = (v: string | undefined, d: number) => (v === undefined || v === null || v === "" ? d : Number(v));
    return {
      maxConcurrent: num(this.env.LIMIT_CONCURRENT_TASKS, DEFAULTS.maxConcurrent),
      containerSecondsPerDay: num(this.env.LIMIT_CONTAINER_SECONDS_PER_DAY, DEFAULTS.containerSecondsPerDay),
      turnsPerDay: num(this.env.LIMIT_TURNS_PER_DAY, DEFAULTS.turnsPerDay),
      retentionDays: num(this.env.TASK_RETENTION_DAYS, DEFAULTS.retentionDays),
    };
  }

  usageToday(): { containerSeconds: number; turns: number } {
    const row = this.ctx.storage.sql
      .exec("SELECT containerSeconds, turns FROM usage WHERE day = ?", day(Date.now()))
      .toArray()[0] as { containerSeconds: number; turns: number } | undefined;
    return row || { containerSeconds: 0, turns: 0 };
  }

  activeCount(): number {
    return this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS n FROM tasks WHERE phase IS NOT NULL AND phase != 'stopped'")
      .one().n as number;
  }

  // A refusal names the meter that refused.
  admit() {
    const l = this.limits();
    const used = this.usageToday();
    const active = this.activeCount();
    if (l.maxConcurrent && active >= l.maxConcurrent) {
      return { ok: false, meter: "concurrent", active, limit: l.maxConcurrent };
    }
    if (l.containerSecondsPerDay && used.containerSeconds >= l.containerSecondsPerDay) {
      return { ok: false, meter: "containerSecondsPerDay", used: used.containerSeconds, limit: l.containerSecondsPerDay };
    }
    if (l.turnsPerDay && used.turns >= l.turnsPerDay) {
      return { ok: false, meter: "turnsPerDay", used: used.turns, limit: l.turnsPerDay };
    }
    return { ok: true, active, used, limits: l };
  }

  record(task: { id: string; objective?: string; repo?: string; branch?: string; phase?: string; createdAt?: number }) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO tasks (id, objective, repo, branch, phase, createdAt, updatedAt) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET objective=excluded.objective, repo=excluded.repo, " +
        "branch=excluded.branch, phase=excluded.phase, updatedAt=excluded.updatedAt",
      task.id,
      task.objective || "",
      task.repo || null,
      task.branch || null,
      task.phase || "booting",
      task.createdAt || now,
      now,
    );
    this.sweep();
    return { ok: true };
  }

  // Reported by the container host as it moves. Usage is only added at the end,
  // and only once: the host reports a stop more than once by design.
  update(u: {
    id: string;
    phase?: string;
    goalStatus?: string;
    stopReason?: string;
    branch?: string;
    stoppedAt?: number;
    containerSeconds?: number;
    turns?: number;
  }) {
    const now = Date.now();
    const before = this.ctx.storage.sql.exec("SELECT stoppedAt, repo FROM tasks WHERE id = ?", u.id).toArray()[0] as
      | { stoppedAt: number | null; repo: string | null }
      | undefined;
    const alreadyAccounted = !!(before && before.stoppedAt);

    this.ctx.storage.sql.exec(
      "UPDATE tasks SET phase=?, goalStatus=?, stopReason=?, branch=COALESCE(?, branch), " +
        "updatedAt=?, stoppedAt=?, containerSeconds=?, turns=? WHERE id=?",
      u.phase || null,
      u.goalStatus || null,
      u.stopReason || null,
      u.branch || null,
      now,
      u.stoppedAt || null,
      u.containerSeconds || 0,
      u.turns || 0,
      u.id,
    );
    if (u.phase === "stopped" && !alreadyAccounted && (u.containerSeconds || u.turns)) {
      this.ctx.storage.sql.exec(
        "INSERT INTO usage (day, containerSeconds, turns) VALUES (?, ?, ?) " +
          "ON CONFLICT(day) DO UPDATE SET containerSeconds = usage.containerSeconds + excluded.containerSeconds, " +
          "turns = usage.turns + excluded.turns",
        day(now),
        u.containerSeconds || 0,
        u.turns || 0,
      );
    }
    this.publish({
      at: now,
      repo: (before && before.repo) || "container",
      agent: "codex-container",
      kind: "container",
      status: u.phase,
      detail: u.stopReason || u.goalStatus || undefined,
      data: { taskId: u.id, containerSeconds: u.containerSeconds || 0 },
    });
    return { ok: true };
  }

  sweep(): string[] {
    const l = this.limits();
    if (!l.retentionDays) return [];
    const cutoff = Date.now() - l.retentionDays * 86400000;
    const doomed = this.ctx.storage.sql
      .exec("SELECT id FROM tasks WHERE stoppedAt IS NOT NULL AND stoppedAt < ?", cutoff)
      .toArray()
      .map((r) => r.id as string);
    if (doomed.length) {
      this.ctx.storage.sql.exec("DELETE FROM tasks WHERE stoppedAt IS NOT NULL AND stoppedAt < ?", cutoff);
    }
    return doomed;
  }

  // ---- apps --------------------------------------------------------------

  registerApp(a: { name: string; need: string; template: string; templateVersion: string; schedule: string | null; mainSha: string | null }) {
    const now = Date.now();
    const next = a.schedule ? nextRun(a.schedule, now) : null;
    this.ctx.storage.sql.exec(
      "INSERT INTO apps (name, need, template, templateVersion, schedule, mainSha, createdAt, nextRunAt) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET need=excluded.need, " +
        "template=excluded.template, templateVersion=excluded.templateVersion, schedule=excluded.schedule, " +
        "mainSha=excluded.mainSha, nextRunAt=excluded.nextRunAt",
      a.name,
      a.need,
      a.template,
      a.templateVersion,
      a.schedule,
      a.mainSha,
      now,
      next,
    );
    return this.app(a.name);
  }

  app(name: string): AppRow | null {
    return (this.ctx.storage.sql.exec("SELECT * FROM apps WHERE name = ?", name).toArray()[0] as unknown as AppRow) || null;
  }

  apps(): AppRow[] {
    return this.ctx.storage.sql.exec("SELECT * FROM apps ORDER BY createdAt").toArray() as unknown as AppRow[];
  }

  siblings(template: string): AppRow[] {
    return this.ctx.storage.sql
      .exec("SELECT * FROM apps WHERE template = ? ORDER BY createdAt", template)
      .toArray() as unknown as AppRow[];
  }

  setMain(name: string, sha: string) {
    this.ctx.storage.sql.exec("UPDATE apps SET mainSha = ? WHERE name = ?", sha, name);
  }

  setTemplateVersion(name: string, version: string) {
    this.ctx.storage.sql.exec("UPDATE apps SET templateVersion = ? WHERE name = ?", version, name);
  }

  due(now: number): AppRow[] {
    return this.ctx.storage.sql
      .exec("SELECT * FROM apps WHERE nextRunAt IS NOT NULL AND nextRunAt <= ?", now)
      .toArray() as unknown as AppRow[];
  }

  markRun(name: string, at: number, report: string | null) {
    const a = this.app(name);
    if (!a) return;
    const next = a.schedule ? nextRun(a.schedule, at) : null;
    this.ctx.storage.sql.exec(
      "UPDATE apps SET lastRunAt = ?, nextRunAt = ?, lastReport = COALESCE(?, lastReport) WHERE name = ?",
      at,
      next,
      report,
      name,
    );
  }

  // ---- meters -----------------------------------------------------------

  meter(kind: string, n = 1) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meters (day, kind, n) VALUES (?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET n = meters.n + excluded.n",
      day(Date.now()),
      kind,
      n,
    );
  }

  meters() {
    const totals: Record<string, number> = {};
    for (const r of this.ctx.storage.sql.exec("SELECT kind, SUM(n) AS n FROM meters GROUP BY kind").toArray()) {
      totals[r.kind as string] = r.n as number;
    }
    const c = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS n, COALESCE(SUM(containerSeconds), 0) AS s FROM tasks")
      .one();
    totals.containers = c.n as number;
    totals.containerSeconds = c.s as number;
    totals.containersRunning = this.activeCount();
    return totals;
  }

  // ---- hub --------------------------------------------------------------

  publish(e: HubEvent) {
    const at = e.at || Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO events (at, repo, agent, kind, status, detail, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      at,
      e.repo,
      e.agent || null,
      e.kind,
      e.status || null,
      e.detail || null,
      e.data === undefined ? null : JSON.stringify(e.data),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?",
      EVENTS_KEPT,
    );
    const line = JSON.stringify({ ...e, at });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(line);
      } catch {
        /* a closed socket is cleaned up by the runtime */
      }
    }
  }

  events(since = 0, limit = 1000): HubEvent[] {
    return this.ctx.storage.sql
      .exec("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", since, limit)
      .toArray()
      .map((r) => ({
        seq: r.seq,
        at: r.at,
        repo: r.repo,
        agent: r.agent,
        kind: r.kind,
        status: r.status,
        detail: r.detail,
        data: r.data ? JSON.parse(r.data as string) : undefined,
      })) as unknown as HubEvent[];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/watch" && request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    switch (url.pathname) {
      case "/admit":
        return Response.json(this.admit());
      case "/record":
        return Response.json(this.record(body as never));
      case "/update":
        return Response.json(this.update(body as never));
      case "/list": {
        const rows = this.ctx.storage.sql.exec("SELECT * FROM tasks ORDER BY createdAt DESC LIMIT 200").toArray();
        return Response.json({
          tasks: rows,
          active: this.activeCount(),
          usage: this.usageToday(),
          limits: this.limits(),
          expired: this.sweep(),
        });
      }
      default:
        return new Response("registry\n", { status: 404 });
    }
  }

  // Hibernation API: the Console only listens.
  async webSocketMessage() {}
  async webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}
