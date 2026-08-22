// One index object per user, named `tenant/<t>/user/<u>`.
//
// A task object's name contains its own task id, so it cannot enumerate its
// siblings -- listing needs somewhere else to look. That somewhere is also the
// only place that can see a user's tasks together, which makes it the only
// place the two brakes can be applied: how many tasks may run at once, and how
// much may be spent in a day.

import { DurableObject } from "cloudflare:workers";

const DEFAULTS = {
  // One task is one container, so this is the first thing between a user and
  // the deployment-wide container ceiling.
  maxConcurrent: 3,
  // Container seconds are the only expensive resource this project owns; turns
  // stand in for model spend, which lands on the deployer's own bill but still
  // has to have a ceiling.
  containerSecondsPerDay: 4 * 60 * 60,
  turnsPerDay: 200,
  retentionDays: 14,
};

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export class UserIndex extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS tasks (" +
          "id TEXT PRIMARY KEY, objective TEXT, repo TEXT, branch TEXT," +
          "phase TEXT, goalStatus TEXT, stopReason TEXT," +
          "createdAt INTEGER, updatedAt INTEGER, stoppedAt INTEGER," +
          "containerSeconds INTEGER DEFAULT 0, turns INTEGER DEFAULT 0)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS usage (" +
          "day TEXT PRIMARY KEY, containerSeconds INTEGER DEFAULT 0, turns INTEGER DEFAULT 0)",
      );
    });
  }

  limits() {
    const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
    return {
      maxConcurrent: num(this.env.LIMIT_CONCURRENT_TASKS, DEFAULTS.maxConcurrent),
      containerSecondsPerDay: num(
        this.env.LIMIT_CONTAINER_SECONDS_PER_DAY,
        DEFAULTS.containerSecondsPerDay,
      ),
      turnsPerDay: num(this.env.LIMIT_TURNS_PER_DAY, DEFAULTS.turnsPerDay),
      retentionDays: num(this.env.TASK_RETENTION_DAYS, DEFAULTS.retentionDays),
    };
  }

  usageToday() {
    const row = this.ctx.storage.sql
      .exec("SELECT containerSeconds, turns FROM usage WHERE day = ?", day(Date.now()))
      .toArray()[0];
    return row || { containerSeconds: 0, turns: 0 };
  }

  activeCount() {
    return this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS n FROM tasks WHERE phase IS NOT NULL AND phase != 'stopped'")
      .one().n;
  }

  // A refusal names the meter that refused. "Dispatch failed" with no reason is
  // indistinguishable from a bug, and the operator is the one who has to tell
  // them apart.
  admit() {
    const l = this.limits();
    const used = this.usageToday();
    const active = this.activeCount();

    if (l.maxConcurrent && active >= l.maxConcurrent) {
      return { ok: false, meter: "concurrent", active, limit: l.maxConcurrent };
    }
    if (l.containerSecondsPerDay && used.containerSeconds >= l.containerSecondsPerDay) {
      return {
        ok: false,
        meter: "containerSecondsPerDay",
        used: used.containerSeconds,
        limit: l.containerSecondsPerDay,
      };
    }
    if (l.turnsPerDay && used.turns >= l.turnsPerDay) {
      return { ok: false, meter: "turnsPerDay", used: used.turns, limit: l.turnsPerDay };
    }
    return { ok: true, active, used, limits: l };
  }

  record(task) {
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

  // Reported by the task object as it moves. Usage is only added at the end,
  // when the numbers are final -- a running task's container seconds are not
  // known until it stops.
  update(u) {
    const now = Date.now();
    // Whether this task has already been accounted for. The host reports the
    // stop more than once by design -- stopTask() reports, and the heartbeat
    // reports again when it sees the phase changed -- so accumulating on every
    // report that says "stopped" double-counts the meter. Idempotence belongs
    // here rather than in the caller: any future reporter gets it for free.
    const before = this.ctx.storage.sql
      .exec("SELECT stoppedAt FROM tasks WHERE id = ?", u.id)
      .toArray()[0];
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
      const d = day(now);
      this.ctx.storage.sql.exec(
        "INSERT INTO usage (day, containerSeconds, turns) VALUES (?, ?, ?) " +
          "ON CONFLICT(day) DO UPDATE SET containerSeconds = usage.containerSeconds + excluded.containerSeconds, " +
          "turns = usage.turns + excluded.turns",
        d,
        u.containerSeconds || 0,
        u.turns || 0,
      );
    }
    return { ok: true };
  }

  // Retention drops the row here; the task object's own storage is dropped by
  // whoever calls /forget on it. A row pointing at an object nobody will ever
  // open again is the same mistake as a workspace record pointing at a deleted
  // directory, so the two must be swept together.
  sweep() {
    const l = this.limits();
    if (!l.retentionDays) return [];
    const cutoff = Date.now() - l.retentionDays * 86400000;
    const doomed = this.ctx.storage.sql
      .exec("SELECT id FROM tasks WHERE stoppedAt IS NOT NULL AND stoppedAt < ?", cutoff)
      .toArray()
      .map((r) => r.id);
    if (doomed.length) {
      this.ctx.storage.sql.exec(
        "DELETE FROM tasks WHERE stoppedAt IS NOT NULL AND stoppedAt < ?",
        cutoff,
      );
    }
    return doomed;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    switch (url.pathname) {
      case "/admit":
        return Response.json(this.admit());
      case "/record":
        return Response.json(this.record(body));
      case "/update":
        return Response.json(this.update(body));
      case "/list": {
        const rows = this.ctx.storage.sql
          .exec("SELECT * FROM tasks ORDER BY createdAt DESC LIMIT 200")
          .toArray();
        return Response.json({
          tasks: rows,
          active: this.activeCount(),
          usage: this.usageToday(),
          limits: this.limits(),
          expired: this.sweep(),
        });
      }
      default:
        return new Response("user index\n", { status: 404 });
    }
  }
}
