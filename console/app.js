// The Console: one sentence in, lanes out.
// Preact + htm as plain ES modules; no build step.

import { h, render } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "content-type": "application/json", ...(opts.headers || {}) } : opts.headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

const STEPS = ["claimed", "started", "pushed", "reviewing", "verdict", "outcome"];
const ORDER = { queued: -1, claimed: 0, started: 1, pushed: 2, reviewing: 3, passed: 4, blocked: 4, failed: 4, merged: 5, archived: 5, done: 5 };

function stepClass(lane, i) {
  const at = ORDER[lane.status] ?? -1;
  if (i === 4 && at >= 4) return lane.status === "blocked" || lane.status === "failed" ? "bad" : "good";
  if (i === 5 && at >= 5) return lane.status === "archived" ? "done" : "good";
  if (i < at || (i === at && at < 4)) return i === at ? "now" : "done";
  return "";
}

const seg = (branch) => branch.replace(/\//g, "~");
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

function Steps({ lane }) {
  return html`<div class="steps" role="img" aria-label=${"status " + lane.status}>
    ${STEPS.map((s, i) => html`${i ? html`<span class="link"></span>` : null}<span class=${"step " + stepClass(lane, i)} title=${s}></span>`)}
  </div>`;
}

function Jev({ decision }) {
  if (!decision || !decision.probabilities) return null;
  const entries = Object.entries(decision.probabilities).sort((a, b) => b[1] - a[1]);
  return html`<div class="jev">
    <span class="muted">${decision.by === "typesafe/jev" ? "Jev" : decision.by || "decision"}: </span>
    ${entries.map(([k, p]) => html`<span class="p"><i style=${"width:" + Math.max(4, Math.round(p * 60)) + "px"}></i>${k} ${Math.round(p * 100)}%</span>`)}
  </div>`;
}

function Lane({ lane, repo }) {
  const review = lane.review;
  const cls = ["lane", lane.status, lane.kind === "container" ? "container" : ""].join(" ");
  return html`<div class=${cls}>
    <div>
      <div class="who">${lane.agent}</div>
      <div class="state">${lane.kind} · ${lane.status}</div>
    </div>
    <div>
      <div class="branch">${lane.branch || lane.workspace || ""}</div>
      <${Steps} lane=${lane} />
    </div>
    <div class="detail">
      ${lane.strategy ? html`<div>${lane.strategy}</div>` : null}
      ${lane.detail && lane.detail !== lane.strategy ? html`<div class="why">${lane.detail}</div>` : null}
      ${review && review.verdict === "reject"
        ? html`<ul class="findings">${review.findings.map((f) => html`<li>${f.rule}: ${f.detail}${f.path ? " (" + f.path + (f.line ? ":" + f.line : "") + ")" : ""}</li>`)}</ul>`
        : null}
      <${Jev} decision=${lane.decision} />
      ${lane.branch && ["pushed", "reviewing", "passed", "blocked"].includes(lane.status)
        ? html`<div><a href=${"/apps/" + repo + "/@" + seg(lane.branch) + "/"} target="_blank" rel="noopener">Preview this version</a></div>`
        : null}
    </div>
  </div>`;
}

function Stage({ repo, app, lanes, mainSha, onChanged }) {
  const [busy, setBusy] = useState("");
  const [request, setRequest] = useState("");
  const [msg, setMsg] = useState("");
  const fileRef = useRef(null);

  const act = async (label, fn) => {
    setBusy(label);
    setMsg("");
    try {
      const r = await fn();
      setMsg(r || "");
      onChanged();
    } catch (e) {
      setMsg("Could not " + label.toLowerCase() + ": " + e.message);
    } finally {
      setBusy("");
    }
  };

  const upload = () => fileRef.current && fileRef.current.click();
  const onFiles = (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append("file", f);
    act("Upload", async () => {
      const r = await api("/apps/" + repo + "/statements", { method: "POST", body: fd });
      return "Uploaded " + r.files.length + " file(s).";
    });
    e.target.value = "";
  };

  const isApp = !!app;
  return html`<section class="stage">
    <div class="stage-head">
      <h1>${repo}</h1>
      ${app ? html`<span class="muted">${app.template} ${app.templateVersion}${app.nextRunAt ? ", next run " + new Date(app.nextRunAt).toUTCString().slice(0, 22) : ""}</span>` : null}
      <div class="actions">
        ${isApp
          ? html`
              <a class="btn quiet" href=${"/apps/" + repo + "/"} target="_blank" rel="noopener">Open app</a>
              <button class="btn quiet" disabled=${!!busy} onClick=${upload}>Upload statements</button>
              <button class="btn" disabled=${!!busy} onClick=${() => act("Run", async () => (await api("/apps/" + repo + "/run", { method: "POST" })).summary)}>
                ${busy === "Run" ? "Running…" : "Run now"}
              </button>`
          : null}
        <input type="file" multiple accept=".csv,.pdf,.txt" ref=${fileRef} onChange=${onFiles} hidden />
      </div>
    </div>
    ${app ? html`<div class="muted">${app.need}</div>` : null}
    ${isApp
      ? html`<form class="change" onSubmit=${(e) => {
          e.preventDefault();
          if (!request.trim()) return;
          act("Ask", async () => {
            const r = await api("/apps/" + repo + "/change", { method: "POST", body: JSON.stringify({ request }) });
            setRequest("");
            return r.plan.kind === "playbook"
              ? r.plan.lanes.length + " agents are trying different strategies."
              : r.plan.kind === "template-fix"
                ? "This is template code: an agent is fixing it in " + r.plan.lanes[0].repo + "."
                : "An agent is on it.";
          });
        }}>
          <input value=${request} onInput=${(e) => setRequest(e.target.value)} placeholder="Ask for a change to this app" aria-label="Ask for a change" />
          <button class="btn quiet" disabled=${!!busy}>Ask</button>
        </form>`
      : null}
    ${msg ? html`<p class=${msg.startsWith("Could not") ? "err" : "muted"}>${msg}</p>` : null}
    <div class="graph">
      <div class="mainline"><span class="label">main</span><span class="bar"></span><span class="sha">${(mainSha || "").slice(0, 8)}</span></div>
      ${lanes.length
        ? lanes.map((l) => html`<${Lane} key=${l.agent} lane=${l} repo=${repo} />`)
        : html`<p class="empty">No agents working here right now.</p>`}
    </div>
  </section>`;
}

function Memory({ tick }) {
  const [commits, setCommits] = useState([]);
  const [err, setErr] = useState("");
  const load = useCallback(() => api("/memory").then((r) => setCommits(r.commits || []), (e) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [tick]);
  return html`<section class="panel">
    <h2>Memory</h2>
    ${err ? html`<p class="err">${err}</p>` : null}
    <ul class="mem">
      ${commits.slice(0, 8).map(
        (c) => html`<li>
          <span>${c.message}</span>
          ${c.parents.length && !c.message.startsWith("Revert") && !c.message.startsWith("Seed")
            ? html`<button onClick=${async () => {
                await api("/memory/revert", { method: "POST", body: JSON.stringify({ sha: c.hash }) });
                load();
              }}>Undo</button>`
            : null}
        </li>`,
      )}
    </ul>
  </section>`;
}

function Log({ events }) {
  return html`<section class="panel">
    <h2>What happened <a class="muted" href="/api/events.ndjson" style="font-weight:400;margin-left:8px">export</a></h2>
    <ul class="log">
      ${events
        .slice(-60)
        .reverse()
        .map(
          (e) => html`<li>
            <time class="num">${new Date(e.at).toLocaleTimeString([], { hour12: false })}</time>
            <span>${e.repo}${e.agent ? " / " + e.agent : ""}</span>
            <span>${e.status && e.status !== e.kind ? e.status + ": " : ""}${e.detail || e.kind}</span>
          </li>`,
        )}
    </ul>
  </section>`;
}

function App() {
  const [state, setState] = useState({ apps: [], meters: {}, templates: [] });
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [lanes, setLanes] = useState({ lanes: [], expectedMain: null });
  const [need, setNeed] = useState("");
  const [run, setRun] = useState(null); // { startedAt, endedAt }
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [memTick, setMemTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const s = await api("/state");
      setState(s);
      setError("");
      if (!selected && s.apps.length) setSelected(s.apps[s.apps.length - 1].name);
    } catch (e) {
      setError(e.message);
    }
  }, [selected]);

  useEffect(() => {
    refresh();
    api("/events?since=0").then((r) => setEvents(r.events || []), () => {});
  }, []);

  useEffect(() => {
    if (!selected) return;
    api("/apps/" + selected + "/lanes").then(setLanes, () => {});
  }, [selected, tick]);

  // Live events: lanes, runs, the container -- straight from the registry.
  useEffect(() => {
    let ws;
    let closed = false;
    const open = () => {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/watch");
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data);
        setEvents((list) => [...list.slice(-500), e]);
        setTick((t) => t + 1);
        if (e.kind === "memory") setMemTick((t) => t + 1);
        if (e.kind === "new-app" && e.status === "ready") {
          setRun((r) => (r && !r.endedAt ? { ...r, endedAt: e.at } : r));
          if (e.data && e.data.app) setSelected(e.data.app);
          refresh();
        }
        if (e.kind === "new-app" && e.status === "forked") refresh();
      };
      ws.onclose = () => {
        if (!closed) setTimeout(open, 2000);
      };
    };
    open();
    return () => {
      closed = true;
      ws && ws.close();
    };
  }, []);

  useEffect(() => {
    if (!run || run.endedAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [run]);

  const submit = async (e) => {
    e.preventDefault();
    if (!need.trim()) return;
    try {
      const r = await api("/needs", { method: "POST", body: JSON.stringify({ need }) });
      setRun({ startedAt: r.startedAt || Date.now(), endedAt: null });
      setNeed("");
    } catch (err) {
      setError(err.message);
    }
  };

  const m = state.meters || {};
  const repos = [...state.apps.map((a) => ({ name: a.name, sub: a.template + " " + a.templateVersion, app: a })), ...state.templates.map((t) => ({ name: t.name, sub: "template" }))];
  const current = state.apps.find((a) => a.name === selected) || null;

  return html`
    <header class="top">
      <div class="brand">Artifacts-OS<small>your agent, on Workers and Artifacts</small></div>
      <div class="meters num" aria-label="usage">
        <span><b>${m.agentRuns || 0}</b>agent runs</span>
        <span><b>${m.containers || 0}</b>containers</span>
        <span><b>${((m.containerSeconds || 0) / 60).toFixed(1)}</b>container minutes</span>
      </div>
    </header>

    <section class="ask">
      <form onSubmit=${submit}>
        <textarea rows="2" value=${need} onInput=${(e) => setNeed(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) submit(e); }}
          placeholder="What do you need done, again and again?" aria-label="What do you need"></textarea>
        ${run ? html`<div class=${"timer num" + (run.endedAt ? " done" : "")}>${clock((run.endedAt || now) - run.startedAt)}</div>` : null}
        <button class="btn">Build it</button>
      </form>
      <p class="hint">One sentence becomes a repository, a few agents working on it at once, and an app that runs on its own schedule.</p>
      ${error ? html`<p class="err">${error}</p>` : null}
    </section>

    <div class="work">
      <nav class="rail" aria-label="Apps">
        <h2>Apps and templates</h2>
        ${repos.map(
          (r) => html`<button class=${"repo" + (r.name === selected ? " on" : "")} onClick=${() => setSelected(r.name)}>
            <div class="name">${r.name}</div><div class="sub">${r.sub}</div>
          </button>`,
        )}
        ${repos.length ? null : html`<p class="muted" style="margin:0 16px">Nothing yet. Describe a need above.</p>`}
      </nav>
      ${selected
        ? html`<${Stage} repo=${selected} app=${current} lanes=${lanes.lanes || []} mainSha=${lanes.expectedMain || (current && current.mainSha)} onChanged=${() => { setTick((t) => t + 1); refresh(); }} />`
        : html`<section class="stage"><p class="empty">Your apps will appear here.</p></section>`}
    </div>

    <div class="lower">
      <${Log} events=${events} />
      <${Memory} tick=${memTick} />
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
