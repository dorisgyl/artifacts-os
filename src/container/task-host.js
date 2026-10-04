// U2 -- the task host.
//
// One Durable Object and one container per task (ADR-01). The Durable Object
// does not run the agent loop; it boots the brain, drives it, records what it
// says, and decides when it is over.
//
// The single most important constraint here is that the host may not hold a
// live handle to anything (ADR-07). Outbound connections stop preventing
// eviction after 15 minutes, a streaming `fetch()` never prevented it at all,
// and a rolling deploy replaces the Worker underneath a running task. So the
// brain's stdin and stdout are a FIFO and a file inside the container, and the
// host reattaches on every heartbeat from a byte offset it keeps in storage.
//
// The heartbeat is also what keeps the container alive: with the low-level
// ctx.container API a container dies within ~30s of its Durable Object having
// nothing to do. The Container base class manages that from the DO alarm, which
// is why alarm() must never be overridden here -- schedule() is the documented
// way to add work of our own.

import { Container } from "@cloudflare/containers";
import { bootScript, configToml, CODEX_VERSION } from "./boot.js";

// Artifacts-OS changes to this file are limited to two things: the clone can
// come from an Artifacts fork (`spec.artifacts`), and a stopped task pushes its
// branch and notes back there. Everything else is codex-cloud as it was.

const HEARTBEAT_IDLE_S = 30;
const HEARTBEAT_WATCHED_S = 2;
const DEFAULT_TOKEN_BUDGET = 2000000;
const DEFAULT_WALLCLOCK_S = 4 * 60 * 60;

// Goal statuses that mean the task has stopped. `blocked` and `usage_limited`
// are resumable upstream, but nothing here resumes them on its own (ADR-06:
// reaching blocked already means the obstacle survived repeated attempts).
// Matches the streaming half of the protocol: `item/agentMessage/delta` and any
// sibling upstream adds. Cheap enough to run per line, and deliberately a test
// on the raw text rather than on parsed JSON -- this runs before parsing.
const DELTA = /"method"\s*:\s*"[^"]*\/delta"/;

const STOPPED = new Set(["complete", "budget_limited", "blocked", "paused", "usage_limited"]);

async function readAll(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return await new Response(v).text();
  } catch {
    return "";
  }
}

export class TaskHost extends Container {
  sleepAfter = "10m";

  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sockets = new Set();
    this.writeChain = Promise.resolve();

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS frames (" +
          "seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, line TEXT NOT NULL)",
      );
      this.task = (await this.ctx.storage.get("task")) || null;
      // Kept apart from the task record: it carries a token and is never served.
      this.artifactsRemote = (await this.ctx.storage.get("artifactsRemote")) || null;
      this.experienceRemote = (await this.ctx.storage.get("experienceRemote")) || null;
      // entrypoint is a class field the base class reads at start time, and a
      // rebuilt instance would otherwise boot an empty container.
      if (this.task) this.entrypoint = ["sh", "-c", this.task.boot];
      this.envVars = this.providerEnv();
    });
  }

  // The base class stops the container when its inactivity window expires.
  // A task that is still running is activity, whatever the container thinks.
  async onActivityExpired() {
    const phase = await this.ctx.storage.get("phase");
    if (phase && phase !== "stopped") {
      this.renewActivityTimeout();
      return;
    }
    await this.stop();
  }

  // ---- transport -------------------------------------------------------

  // Every write goes through one chain. FIFO writes are atomic only up to
  // PIPE_BUF (4096 on Linux) and a goal objective is comfortably past that, so
  // two concurrent writers could interleave into one corrupt line.
  send(msg) {
    const line = JSON.stringify(msg) + "\n";
    this.writeChain = this.writeChain
      .then(async () => {
        const body = new Blob([line]).stream();
        await this.ctx.container.exec(["sh", "-c", "cat > /state/in.fifo"], { stdin: body });
      })
      .catch(() => {});
    return this.writeChain;
  }

  async sh(cmd) {
    const proc = await this.ctx.container.exec(["sh", "-c", cmd]);
    const res = await proc.output();
    return await readAll(res && res.stdout !== undefined ? res.stdout : res);
  }

  // ---- lifecycle -------------------------------------------------------

  // Where the model traffic goes, and what it carries.
  //
  // Routing through AI Gateway is not only about usage visibility: with the
  // provider key stored at the gateway, the container carries a gateway token
  // instead of an OpenAI key. The agent can still read whatever is in its own
  // container (ADR-04), but what it can read is now scoped to one gateway and
  // revocable on its own, rather than being spend authority on the whole
  // OpenAI account.
  outbound(spec) {
    const token = this.env.AI_GATEWAY_TOKEN;
    // Any endpoint on the gateway needs the gateway's own credential, whoever
    // chose the URL. Leaving that to the caller means a dispatch that names a
    // gateway path gets rejected by the gateway before it routes anywhere, and
    // the error looks like a provider problem rather than a missing header.
    const withGatewayAuth = (headers, baseUrl) =>
      token && baseUrl && baseUrl.includes("gateway.ai.cloudflare.com")
        ? { ...(headers || {}), "cf-aig-authorization": "Bearer " + token }
        : headers || null;

    if (spec.baseUrl) {
      // An explicit endpoint may or may not want a provider key on this side:
      // something that holds the key in front of it wants `envKey: null`.
      return {
        baseUrl: spec.baseUrl,
        extraHeaders: withGatewayAuth(spec.extraHeaders, spec.baseUrl),
        envKey: spec.envKey === undefined ? "OPENAI_API_KEY" : spec.envKey,
      };
    }
    const account = this.env.CF_ACCOUNT_ID;
    if (!account || !token) return { baseUrl: null, extraHeaders: null, envKey: null };
    const gateway = this.env.AI_GATEWAY_NAME || "default";
    return {
      baseUrl:
        "https://gateway.ai.cloudflare.com/v1/" + account + "/" + gateway + "/openai",
      extraHeaders: { "cf-aig-authorization": "Bearer " + token },
      // Deliberately absent: the gateway holds the provider key.
      envKey: null,
    };
  }

  // Passed to the container by the base class at start time, so it never lands
  // in argv or in stored task state. Only needed on the direct path -- through
  // the gateway there is no provider key on this side at all.
  providerEnv() {
    const direct = !(this.env.CF_ACCOUNT_ID && this.env.AI_GATEWAY_TOKEN);
    const out = direct && this.env.OPENAI_API_KEY
      ? { OPENAI_API_KEY: this.env.OPENAI_API_KEY }
      : {};
    if (this.artifactsRemote) out.ARTIFACTS_GIT_REMOTE = this.artifactsRemote;
    if (this.experienceRemote) out.EXPERIENCE_GIT_REMOTE = this.experienceRemote;
    return out;
  }

  async dispatch(spec) {
    if (this.task) return { error: "task already dispatched" };

    const model = spec.model || null;
    const { baseUrl, extraHeaders, envKey } = this.outbound(spec);
    const art = spec.artifacts || null;
    if (art) {
      this.artifactsRemote = art.remote;
      this.experienceRemote = art.experienceRemote || null;
      await this.ctx.storage.put({ artifactsRemote: art.remote, experienceRemote: this.experienceRemote });
    }
    const boot = bootScript({
      configToml: configToml({ baseUrl, model, extraHeaders, envKey }),
      repo: art ? null : spec.repo || null,
      branch: art ? art.branch : spec.branch || null,
      fromEnv: !!art,
      node: !!art,
    });

    const now = Date.now();
    this.task = {
      id: spec.id || crypto.randomUUID(),
      repo: art ? art.workspace : spec.repo || null,
      branch: art ? art.branch : spec.branch || null,
      // Where the result goes, without the credentials.
      artifacts: art ? { app: art.app, workspace: art.workspace, branch: art.branch, agent: art.agent } : null,
      objective: spec.objective,
      tokenBudget: spec.tokenBudget || DEFAULT_TOKEN_BUDGET,
      // The second brake. The token budget bounds model spend; nothing in it
      // bounds container seconds, and a goal whose turns keep failing keeps
      // starting new ones without moving the token counter at all.
      deadlineAt: now + (spec.wallClockSeconds || DEFAULT_WALLCLOCK_S) * 1000,
      codexVersion: CODEX_VERSION,
      baseUrl,
      model,
      createdAt: now,
      // Supplied by the edge, which derived it from verified identity. The task
      // never takes an owner from its caller.
      owner: spec.owner || null,
      boot,
    };

    this.entrypoint = ["sh", "-c", boot];
    this.envVars = this.providerEnv();
    await this.ctx.storage.put({
      task: this.task,
      phase: "booting",
      offset: 1,
      turns: 0,
      containerStartedAt: now,
    });

    try {
      await this.start();
    } catch (e) {
      await this.fail("container-start", String(e && e.message ? e.message : e));
      return { error: "container start failed", detail: String(e) };
    }
    await this.schedule(2, "heartbeat");
    return { ok: true, task: this.publicTask() };
  }

  // The index is a separate object, so this is best effort by construction: a
  // failed report must never take a running task down with it.
  async report(extra) {
    if (!this.task || !this.task.owner) return;
    const name = "tenant/" + this.task.owner.tenant + "/user/" + this.task.owner.user;
    const goal = await this.ctx.storage.get("goal");
    const scene = await this.ctx.storage.get("scene");
    const startedAt = (await this.ctx.storage.get("containerStartedAt")) || this.task.createdAt;
    const stoppedAt = await this.ctx.storage.get("stoppedAt");
    const payload = {
      id: this.task.id,
      phase: await this.ctx.storage.get("phase"),
      goalStatus: goal ? goal.status : null,
      stopReason: scene ? scene.reason : null,
      branch: scene ? scene.branch : null,
      stoppedAt: stoppedAt || null,
      turns: (await this.ctx.storage.get("turns")) || 0,
      containerSeconds: Math.round(((stoppedAt || Date.now()) - startedAt) / 1000),
      ...extra,
    };
    try {
      await this.env.INDEX.get(this.env.INDEX.idFromName(name)).fetch(
        new Request("https://index/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    } catch {
      /* the index is a convenience; the task is the record */
    }
  }

  async heartbeat() {
    const phase = await this.ctx.storage.get("phase");
    if (!phase || phase === "stopped") return;
    try {
      await this.step(phase);
    } catch (e) {
      this.note("host-error", String(e && e.stack ? e.stack : e));
    }
    const still = await this.ctx.storage.get("phase");
    if (still !== phase) await this.report();
    if (still && still !== "stopped") {
      this.renewActivityTimeout();
      // Boot is a sequence of short waits, so beating slowly through it would
      // add half a minute to every dispatch for nothing. The idle cadence is
      // for a task that is actually running with nobody watching.
      const settled = still === "running";
      await this.schedule(
        !settled || this.sockets.size > 0 ? HEARTBEAT_WATCHED_S : HEARTBEAT_IDLE_S,
        "heartbeat",
      );
    }
  }

  async step(phase) {
    if (!this.ctx.container.running) {
      return this.fail("container-gone", "the container is no longer running");
    }
    if (Date.now() > this.task.deadlineAt) {
      return this.stopTask("wallclock", "the task passed its wall-clock limit");
    }

    const fatal = (await this.sh("cat /state/fatal 2>/dev/null")).trim();
    if (fatal) {
      return this.fail("boot", fatal + "\n" + (await this.sh("tail -30 /state/boot.log")));
    }

    if (phase === "booting") {
      const ready = (await this.sh("cat /state/ready 2>/dev/null")).trim();
      if (ready && !(await this.ctx.storage.get("released"))) {
        const rollout = await this.ctx.storage.get("rollout");
        const path = await this.ctx.storage.get("rolloutPath");
        if (rollout && path) {
          // Put the recording of the previous run back where upstream expects
          // it. Without this, thread/resume has nothing to resume and `blocked`
          // is a terminal state wearing a resumable name (ADR-03).
          const dir = path.slice(0, path.lastIndexOf("/"));
          await this.ctx.container.exec(
            ["sh", "-c", "mkdir -p " + dir + " && cat > " + path],
            { stdin: new Blob([rollout]).stream() },
          );
          this.note("restored", "rollout restored to " + path);
        }
        await this.sh("touch /state/go");
        await this.ctx.storage.put("released", true);
        return;
      }
      const up = (await this.sh("cat /state/up.txt 2>/dev/null")).trim();
      if (!up) return;
      await this.send({
        method: "initialize",
        id: 0,
        params: { clientInfo: { name: "codex_cloud", title: "codex-cloud", version: "0.0.1" } },
      });
      await this.ctx.storage.put("phase", "handshake");
      return;
    }

    await this.drain();
    const p2 = await this.ctx.storage.get("phase");

    if (p2 === "handshake" && (await this.ctx.storage.get("initialized"))) {
      await this.send({ method: "initialized" });
      const resuming = await this.ctx.storage.get("threadId");
      await this.send(
        resuming
          ? { method: "thread/resume", id: 1, params: { threadId: resuming } }
          : { method: "thread/start", id: 1, params: {} },
      );
      await this.ctx.storage.put("phase", "starting");
      return;
    }

    if (p2 === "starting" && (await this.ctx.storage.get("threadReady"))) {
      const threadId = await this.ctx.storage.get("threadId");
      // Setting the goal *is* the dispatch: upstream starts a turn on it within
      // milliseconds, so there is no turn/start of our own to send.
      await this.send({
        method: "thread/goal/set",
        id: 2,
        params: {
          threadId,
          objective: this.task.objective,
          tokenBudget: this.task.tokenBudget,
          // Explicit rather than implied: a goal that stopped at blocked or
          // paused is still there, and setting an objective alone would leave
          // it stopped.
          status: "active",
        },
      });
      await this.ctx.storage.put("phase", "running");
      return;
    }

    if (p2 === "running") {
      const goal = await this.ctx.storage.get("goal");
      if (goal && STOPPED.has(goal.status)) {
        return this.stopTask(goal.status, "the goal reached " + goal.status);
      }
    }
  }

  // Pull whatever the brain has written since the last heartbeat. The offset and
  // the frames must move together: a crash between them either replays a stretch
  // of the recording or loses one, and both are silent.
  async drain() {
    const offset = (await this.ctx.storage.get("offset")) || 1;
    const chunk = await this.sh("tail -c +" + offset + " /state/out.jsonl 2>/dev/null");
    if (!chunk) return;

    const cut = chunk.lastIndexOf("\n");
    if (cut < 0) return; // a partial line; wait for the rest
    const complete = chunk.slice(0, cut + 1);
    const advance = new TextEncoder().encode(complete).length;
    const lines = complete.split("\n").filter(Boolean);
    const at = Date.now();

    const learned = {};
    for (const line of lines) this.interpret(line, learned);

    // Deltas are broadcast live and never stored. A delta is not a unit anyone
    // reads back: the assembled `item/completed` that follows carries the whole
    // text. Measured on the first task that reached a real model, 69% of frames
    // were `item/agentMessage/delta` -- keeping them triples the recording and
    // makes every reader re-fold what upstream already folded.
    const durable = lines.filter((l) => !DELTA.test(l));
    if (learned.turnStarted) {
      delete learned.turnStarted;
      learned.turns = ((await this.ctx.storage.get("turns")) || 0) + 1;
    }

    this.ctx.storage.transactionSync(() => {
      for (const line of durable) {
        this.ctx.storage.sql.exec("INSERT INTO frames (at, line) VALUES (?, ?)", at, line);
      }
    });
    await this.ctx.storage.put({ ...learned, offset: offset + advance });

    for (const line of lines) this.broadcast(line);
  }

  // The host reads three things and nothing else (ADR-02): the JSON-RPC
  // envelope, the goal status, and how a turn ended. Everything else is a frame
  // it stores without understanding.
  interpret(line, learned) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === 0 && m.result) learned.initialized = true;
    if (m.id === 1 && m.result && m.result.thread) {
      learned.threadId = m.result.thread.id;
      learned.rolloutPath = m.result.thread.path || null;
      // On a restart the thread id is already known from the previous run, so
      // "do we have an id" cannot mean "is the thread ready". Only the reply can.
      learned.threadReady = true;
    }
    if (m.method === "thread/goal/updated" && m.params && m.params.goal) {
      learned.goal = {
        status: m.params.goal.status,
        objective: m.params.goal.objective,
        tokenBudget: m.params.goal.tokenBudget,
        tokensUsed: m.params.goal.tokensUsed,
        timeUsedSeconds: m.params.goal.timeUsedSeconds,
        // Non-null means the change came out of the agent's own work; null means
        // somebody called the API. The stop page must not present an
        // infrastructure failure as "the agent gave up after three tries".
        fromTurn: m.params.turnId || null,
        at: Date.now(),
      };
    }
    // A failed turn arrives as turn/completed with status "failed"; there is no
    // turn/failed method on this protocol -- that name belongs to the reduced
    // projection `codex exec --json` emits.
    if (m.method === "turn/started") learned.turnStarted = true;
    if (m.method === "turn/completed" && m.params && m.params.turn) {
      learned.lastTurn = {
        id: m.params.turn.id,
        status: m.params.turn.status,
        error: m.params.turn.error ? m.params.turn.error.message : null,
      };
    }
  }

  // Preserving the scene is part of stopping, not something done afterwards:
  // once the container is gone none of it can be reconstructed.
  async stopTask(reason, detail) {
    await this.ctx.storage.put("phase", "stopping");
    const scene = { reason, detail, at: Date.now() };

    try {
      await this.drain();
    } catch {
      /* the tail of the recording is best-effort */
    }

    if (this.task.artifacts) {
      // Artifacts-OS: commit whatever is left on the branch Codex was given and
      // push it, with its notes, to the workspace fork. The push event brings
      // it back into the app as a branch for review.
      const a = this.task.artifacts;
      scene.branch = a.branch;
      try {
        scene.git = (
          await this.sh(
            "cd /workspace && git add -A && (git diff --cached --quiet || git commit -q -m 'Finish " +
              a.branch.replace(/'/g, "") + " in a container'); " +
              // Notes first, so they are in the fork when the branch push is imported.
              "git push -f origin 'refs/notes/intent/*:refs/notes/intent/*' 2>&1 | sed 's#//[^@]*@#//***@#' | tail -1; " +
              "git push -f origin HEAD:refs/heads/" + a.branch + " 2>&1 | sed 's#//[^@]*@#//***@#' | tail -2; " +
              "git rev-parse HEAD",
          )
        ).trim();
        const head = scene.git.split("\n").pop();
        scene.pushed = /^[0-9a-f]{40}$/.test(head || "");
        scene.head = scene.pushed ? head : null;
      } catch (e) {
        scene.git = "push failed: " + String(e);
        scene.pushed = false;
      }
      try {
        const coord = this.env.COORD.get(this.env.COORD.idFromName(a.app));
        await coord.laneEvent(
          a.agent,
          scene.pushed ? "pushed" : "failed",
          scene.pushed ? "pushed " + a.branch + " to " + a.workspace + " (" + reason + ")" : "container stopped without a push: " + reason,
          scene.pushed ? { head: scene.head } : {},
        );
      } catch {
        /* the push event is the record; the lane is the view */
      }
    } else if (this.task.repo) {
      try {
        const branch = "codex-cloud/" + this.task.id.slice(0, 8);
        scene.branch = branch;
        scene.git = (
          await this.sh(
            "cd /workspace && " +
              "git config user.email codex@codex-cloud.invalid && " +
              "git config user.name codex-cloud && " +
              "git checkout -b " + branch + " 2>&1 | tail -1; " +
              "git add -A && git commit -m 'codex-cloud work in progress' 2>&1 | tail -2; " +
              "git log --oneline -1 2>&1",
          )
        ).trim();
      } catch (e) {
        scene.git = "commit failed: " + String(e);
      }
    }

    try {
      const rollout = await this.ctx.storage.get("rolloutPath");
      if (rollout) {
        const text = await this.sh("cat " + rollout + " 2>/dev/null");
        scene.rolloutBytes = new TextEncoder().encode(text || "").length;
        if (text) await this.ctx.storage.put("rollout", text);
      }
    } catch {
      /* a missing rollout means the thread never materialised */
    }

    await this.ctx.storage.put({ scene, phase: "stopped", stoppedAt: Date.now() });
    this.note("stopped", reason);
    await this.report();

    // Explicit: a finished task keeps its container slot until sleepAfter
    // expires, and max_instances is the deployment-wide concurrency ceiling.
    try {
      await this.destroy();
    } catch {
      /* already gone */
    }
  }

  async fail(reason, detail) {
    await this.ctx.storage.put({
      scene: { reason, detail, at: Date.now() },
      phase: "stopped",
      stoppedAt: Date.now(),
    });
    this.note("failed", reason + ": " + detail);
    await this.report();
    try {
      await this.destroy();
    } catch {
      /* already gone */
    }
  }

  // Host-side events join the recording so a reader sees one timeline. They are
  // namespaced so they can never be mistaken for something the brain said.
  note(kind, message) {
    const line = JSON.stringify({
      method: "codexCloud/" + kind,
      params: { message },
      at: Date.now(),
    });
    this.ctx.storage.sql.exec("INSERT INTO frames (at, line) VALUES (?, ?)", Date.now(), line);
    this.broadcast(line);
  }

  // ---- surface ---------------------------------------------------------

  broadcast(line) {
    for (const ws of this.sockets) {
      try {
        ws.send(line);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  publicTask() {
    if (!this.task) return null;
    const { boot, ...rest } = this.task;
    return rest;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");

    if (path === "/dispatch" && request.method === "POST") {
      return Response.json(await this.dispatch(await request.json()));
    }

    if (path === "/state") {
      const stored = Object.fromEntries(await this.ctx.storage.list());
      delete stored.task;
      delete stored.rollout;
      const frames = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM frames").one().n;
      return Response.json({
        task: this.publicTask(),
        containerRunning: this.ctx.container ? this.ctx.container.running : null,
        frames,
        codexVersion: CODEX_VERSION,
        ...stored,
      });
    }

    if (path === "/frames") {
      const since = Number(url.searchParams.get("since") || 0);
      const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
      const rows = this.ctx.storage.sql
        .exec("SELECT seq, at, line FROM frames WHERE seq > ? ORDER BY seq LIMIT ?", since, limit)
        .toArray();
      return Response.json({ frames: rows });
    }

    if (path === "/stop" && request.method === "POST") {
      // A person pausing a task is not a stop reason the model can report; it is
      // the only way "it went the wrong way" can be expressed (ADR-06).
      const threadId = await this.ctx.storage.get("threadId");
      if (threadId) {
        await this.send({ method: "turn/interrupt", id: 90, params: { threadId } });
        await this.send({
          method: "thread/goal/set",
          id: 91,
          params: { threadId, status: "paused" },
        });
      }
      await this.stopTask("paused", "stopped by request");
      return Response.json({ ok: true });
    }

    if (path === "/watch" && request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      this.sockets.add(pair[1]);
      pair[1].addEventListener("close", () => this.sockets.delete(pair[1]));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === "/restart" && request.method === "POST") {
      // The only way "it went the wrong way" gets expressed: a person reads the
      // recording, rewrites the objective, and sets the goal back to active.
      // Upstream treats that as a fresh judgement -- a resumed goal starts its
      // blocked audit over from zero.
      if ((await this.ctx.storage.get("phase")) !== "stopped") {
        return Response.json({ error: "task is not stopped" }, { status: 409 });
      }
      const body = await request.json().catch(() => ({}));
      if (body.objective) this.task.objective = String(body.objective);

      const scene = await this.ctx.storage.get("scene");
      // Pick up where the previous run left off, if its work reached a remote.
      // Without a push the branch died with the container: the conversation
      // comes back and the working tree does not (see the README limitation).
      // Rebuilt rather than reused: a token rotated between runs must take
      // effect on restart, and the stored task predates the rotation.
      const out = this.outbound({ baseUrl: null });
      const boot = bootScript({
        configToml: configToml({
          baseUrl: out.baseUrl,
          model: this.task.model,
          extraHeaders: out.extraHeaders,
          envKey: out.envKey,
        }),
        repo: this.task.artifacts ? null : this.task.repo,
        branch: (scene && scene.pushed && scene.branch) || this.task.branch,
        fromEnv: !!this.task.artifacts,
        node: !!this.task.artifacts,
      });
      this.task.boot = boot;
      this.entrypoint = ["sh", "-c", boot];
      this.envVars = this.providerEnv();

      await this.ctx.storage.put({
        task: this.task,
        phase: "booting",
        offset: 1,
        released: false,
        threadReady: false,
        containerStartedAt: Date.now(),
      });
      await this.ctx.storage.delete("scene");
      this.note("restart", "restarted with objective: " + this.task.objective);

      try {
        await this.start();
      } catch (e) {
        await this.fail("container-start", String(e && e.message ? e.message : e));
        return Response.json({ error: "container start failed" }, { status: 500 });
      }
      await this.schedule(2, "heartbeat");
      await this.report();
      return Response.json({ ok: true, task: this.publicTask() });
    }

    if (path === "/forget" && request.method === "POST") {
      // Retention drops the index row; this drops the recording. The two have
      // to be swept together or the list ends up pointing at objects nobody
      // will ever open again -- the same mistake as a workspace record that
      // outlives its directory.
      try {
        await this.destroy();
      } catch {
        /* already gone */
      }
      await this.ctx.storage.deleteAll();
      return Response.json({ ok: true });
    }

    if (path === "/diagnostics") {
      const out = {};
      const probes = {
        boot: "tail -40 /state/boot.log 2>/dev/null",
        err: "tail -c 1500 /state/err.log 2>/dev/null",
        bin: "cat /state/bin.txt 2>/dev/null",
        head: "cat /state/head.txt 2>/dev/null",
        ls: "ls /workspace 2>/dev/null | head -20",
      };
      for (const [k, cmd] of Object.entries(probes)) {
        try {
          out[k] = (await this.sh(cmd)).trim();
        } catch (e) {
          out[k] = "<" + String(e) + ">";
        }
      }
      return Response.json(out);
    }

    return new Response("codex-host: /dispatch /state /frames /stop /watch /diagnostics\n", {
      status: 404,
    });
  }
}
