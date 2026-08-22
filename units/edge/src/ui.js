// The thin UI, served as one string from the edge. No build step: a page that
// needs a toolchain to change is a page nobody changes.
//
// It renders the frame log and nothing more (ADR-02 pushed the protocol
// coupling out of the host and onto the client, so it lands here). Anything it
// does not recognise degrades to one grey line rather than an error, because
// upstream adds item types between releases and a rendering gap must not look
// like a broken deployment.
//
// There is deliberately no diff view: the work is already on a branch, and
// GitHub renders diffs better than this ever would.

export const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>codex-cloud</title>
<style>
:root{--bg:#fbfbfa;--fg:#1a1a19;--dim:#6b6b66;--line:#e3e3df;--card:#fff;--accent:#3b5bdb;
      --ok:#2f7a3e;--warn:#9a6b00;--stop:#a33;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--fg:#e8e8e4;--dim:#8a8a83;--line:#2c2c29;
      --card:#1d1d1b;--accent:#8da2fb;--ok:#7bc98a;--warn:#d9a441;--stop:#e8867d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 18px 80px}
h1{font-size:17px;margin:0 0 2px;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:13px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.04em}
input,textarea,button{font:inherit;color:inherit;background:var(--bg);
  border:1px solid var(--line);border-radius:7px;padding:8px 10px;width:100%}
textarea{min-height:76px;resize:vertical}
button{background:var(--accent);color:#fff;border:0;cursor:pointer;font-weight:600;width:auto;padding:9px 18px}
button:disabled{opacity:.5;cursor:default}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:400}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grow{flex:1;min-width:180px}
.badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.badge.run{color:var(--accent);border-color:var(--accent)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.stop{color:var(--stop);border-color:var(--stop)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
.meter{height:5px;background:var(--line);border-radius:3px;overflow:hidden;margin:8px 0 3px}
.meter i{display:block;height:100%;background:var(--accent)}
.task{display:block;padding:11px 0;border-top:1px solid var(--line);cursor:pointer}
.task:first-child{border-top:0}
.task .o{font-weight:600}
.muted{color:var(--dim);font-size:13px}
.frames{font-family:var(--mono);font-size:12.5px;line-height:1.5}
.f{padding:4px 0;border-top:1px solid var(--line);white-space:pre-wrap;word-break:break-word}
.f.unknown{color:var(--dim)}
.f .k{color:var(--dim);margin-right:8px}
.f pre{margin:5px 0 0;padding:8px;background:var(--bg);border-radius:6px;overflow-x:auto;max-height:260px}
details summary{cursor:pointer;color:var(--dim)}
a{color:var(--accent)}
.err{color:var(--stop)}
.todo{margin:6px 0 0;padding-left:18px}
</style></head><body><main>
<h1>codex-cloud</h1>
<div class="sub" id="who">…</div>
<div id="view"></div>
</main>
<script>
const $ = (h) => { const d=document.createElement('div'); d.innerHTML=h.trim(); return d.firstChild }
const esc = (s) => String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
const view = document.getElementById('view')
let ws = null

const BADGE = { complete:'ok', blocked:'stop', paused:'warn', budget_limited:'stop',
                usage_limited:'warn', active:'run', running:'run', booting:'run',
                handshake:'run', starting:'run', stopped:'stop' }

async function api(path, opts) {
  const r = await fetch('/api' + path, opts)
  const b = await r.json().catch(() => ({ error: 'unparseable response' }))
  if (b.error && !b.tasks && !b.taskId) throw new Error(b.error + (b.detail ? ': '+b.detail : ''))
  return b
}

// ---- list -------------------------------------------------------------

async function showList() {
  if (ws) { ws.close(); ws = null }
  location.hash = ''
  const d = await api('/tasks')
  const u = d.usage || {}, l = d.limits || {}
  view.innerHTML = ''
  view.appendChild($(\`<div class="card">
    <label>objective</label>
    <textarea id="obj" placeholder="What should it do? Be specific about the end state."></textarea>
    <div class="row">
      <div class="grow"><label>repository</label><input id="repo" placeholder="https://github.com/you/thing.git"></div>
      <div style="width:130px"><label>branch</label><input id="branch" placeholder="main"></div>
    </div>
    <div class="row">
      <div style="width:150px"><label>token budget</label><input id="budget" value="2000000"></div>
      <div style="width:150px"><label>wall clock (s)</label><input id="wall" value="14400"></div>
      <div class="grow" style="text-align:right;padding-top:20px"><button id="go">Dispatch</button></div>
    </div>
    <div class="muted" id="dispatch-msg" style="margin-top:8px"></div>
  </div>\`))
  view.appendChild($(\`<div class="card">
    <div class="row" style="justify-content:space-between">
      <b>Tasks</b>
      <span class="muted">\${d.active||0} running · \${u.containerSeconds||0}/\${l.containerSecondsPerDay||'∞'}s · \${u.turns||0}/\${l.turnsPerDay||'∞'} turns today</span>
    </div>
    <div id="tasks" style="margin-top:6px"></div>
  </div>\`))

  const list = document.getElementById('tasks')
  if (!d.tasks || !d.tasks.length) list.innerHTML = '<div class="muted" style="padding:10px 0">Nothing dispatched yet.</div>'
  for (const t of d.tasks || []) {
    const s = t.goalStatus || t.phase || 'unknown'
    const el = $(\`<div class="task">
      <div class="row" style="justify-content:space-between">
        <span class="o">\${esc(t.objective).slice(0,110)}</span>
        <span class="badge \${BADGE[s]||''}">\${esc(s)}</span>
      </div>
      <div class="muted">\${esc(t.repo||'no repository')} · \${new Date(t.createdAt).toLocaleString()}\${t.turns?' · '+t.turns+' turns':''}</div>
    </div>\`)
    el.onclick = () => showTask(t.id)
    list.appendChild(el)
  }

  document.getElementById('go').onclick = async (e) => {
    const msg = document.getElementById('dispatch-msg')
    e.target.disabled = true; msg.textContent = 'dispatching…'
    try {
      const body = {
        objective: document.getElementById('obj').value,
        repo: document.getElementById('repo').value || null,
        branch: document.getElementById('branch').value || null,
        tokenBudget: Number(document.getElementById('budget').value) || undefined,
        wallClockSeconds: Number(document.getElementById('wall').value) || undefined,
      }
      const r = await api('/tasks', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
      showTask(r.taskId)
    } catch (err) {
      msg.innerHTML = '<span class="err">' + esc(err.message) + '</span>'
      e.target.disabled = false
    }
  }
}

// ---- one task ---------------------------------------------------------

async function showTask(id) {
  location.hash = id
  if (ws) { ws.close(); ws = null }
  const st = await api('/tasks/' + id + '/state')
  view.innerHTML = ''

  const goal = st.goal || {}
  const status = goal.status || st.phase || 'unknown'
  const scene = st.scene || {}
  const task = st.task || {}
  const live = st.phase && st.phase !== 'stopped'

  const head = $(\`<div class="card">
    <div class="row" style="justify-content:space-between">
      <span class="badge \${BADGE[status]||''}">\${esc(status)}</span>
      <span class="row" style="gap:8px">
        \${live?'<button id="stop" class="ghost">Stop</button>':'<button id="restart" class="ghost">Restart…</button>'}
        <button id="back" class="ghost">All tasks</button>
      </span>
    </div>
    <div style="margin-top:10px;font-weight:600">\${esc(goal.objective || task.objective)}</div>
    <div id="why" class="muted" style="margin-top:8px"></div>
    <div class="meter"><i style="width:\${Math.min(100, 100*(goal.tokensUsed||0)/(goal.tokenBudget||1))}%"></i></div>
    <div class="muted">\${(goal.tokensUsed||0).toLocaleString()} / \${(goal.tokenBudget||0).toLocaleString()} tokens · \${goal.timeUsedSeconds||0}s · \${st.frames||0} frames</div>
    <div id="todo"></div>
    <div class="muted" id="links" style="margin-top:8px"></div>
  </div>\`)
  view.appendChild(head)
  document.getElementById('back').onclick = showList
  // Restarting is the only way a person can say "it went the wrong way" -- the
  // model has no status for that, and rewriting the objective is the whole
  // point of the gesture, so the field is prefilled rather than blank.
  const restartBtn = document.getElementById('restart')
  if (restartBtn) restartBtn.onclick = () => {
    if (document.getElementById('restart-box')) return
    const box = $(\`<div style="margin-top:12px">
      <label>rewrite the objective, then restart</label>
      <textarea id="new-obj"></textarea>
      <div class="row" style="margin-top:8px"><button id="do-restart">Restart</button>
      <span class="muted" id="restart-msg"></span></div>
    </div>\`)
    box.id = 'restart-box'
    head.appendChild(box)
    document.getElementById('new-obj').value = goal.objective || task.objective || ''
    document.getElementById('do-restart').onclick = async (e) => {
      e.target.disabled = true
      document.getElementById('restart-msg').textContent = 'restarting…'
      const r = await fetch('/api/tasks/' + id + '/restart', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({ objective: document.getElementById('new-obj').value }),
      })
      const b = await r.json().catch(() => ({}))
      if (b.error) {
        document.getElementById('restart-msg').innerHTML = '<span class="err">' + esc(b.error) + '</span>'
        e.target.disabled = false
      } else showTask(id)
    }
  }

  const stopBtn = document.getElementById('stop')
  if (stopBtn) stopBtn.onclick = async () => {
    stopBtn.disabled = true
    await fetch('/api/tasks/' + id + '/stop', { method: 'POST' })
    showTask(id)
  }

  // Why it stopped. Upstream carries no reason field on a goal -- the narrative
  // is the last thing the agent said before it changed the status, so that is
  // what gets shown, next to whether the last turn ended in an error. Those are
  // different things: an agent that gave up after repeated attempts and a
  // credential that was never valid both arrive as blocked.
  const why = document.getElementById('why')
  const bits = []
  if (scene.reason) bits.push('Stopped: <b>' + esc(scene.reason) + '</b>')
  if (st.lastTurn && st.lastTurn.status === 'failed' && st.lastTurn.error) {
    bits.push('<span class="err">last turn failed — ' + esc(st.lastTurn.error).slice(0,300) + '</span>')
  } else if (goal.fromTurn) {
    bits.push('reported by the agent during a turn')
  } else if (goal.at) {
    bits.push('set through the API, not by the agent')
  }
  why.innerHTML = bits.join('<br>')

  if (task.repo && scene.branch) {
    const web = task.repo.replace(/\\.git$/, '').replace(/^git@github\\.com:/, 'https://github.com/')
    document.getElementById('links').innerHTML =
      'Work is on <a href="' + esc(web) + '/tree/' + esc(scene.branch) + '">' + esc(scene.branch) + '</a> · ' +
      '<a href="' + esc(web) + '/compare/' + esc(scene.branch) + '">compare</a>'
  }

  const rec = $('<div class="card"><b>Recording</b><div class="frames" id="frames"></div></div>')
  view.appendChild(rec)
  const frames = document.getElementById('frames')

  let since = 0
  const seen = new Map()
  const drain = async () => {
    const d = await api('/tasks/' + id + '/frames?since=' + since + '&limit=500')
    for (const f of d.frames) { since = f.seq; render(frames, f.line, seen) }
    if (d.frames.length === 500) return drain()
  }
  await drain()

  if (live) {
    ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/tasks/' + id + '/watch')
    ws.onmessage = (e) => { render(frames, e.data, seen); frames.scrollIntoView({block:'end'}) }
    ws.onclose = () => { ws = null }
  }
}

// ---- frame rendering --------------------------------------------------

function line(kind, html, cls) {
  return \`<div class="f \${cls||''}"><span class="k">\${esc(kind)}</span>\${html}</div>\`
}

function render(root, raw, seen) {
  let m
  try { m = JSON.parse(raw) } catch { return root.appendChild($(line('raw', esc(raw), 'unknown'))) }
  const p = m.params || {}

  if (m.method === 'codexCloud/stopped') return root.appendChild($(line('host', 'task stopped: ' + esc(p.message))))
  if (m.method === 'codexCloud/failed')  return root.appendChild($(line('host', esc(p.message), 'err')))
  if (m.method === 'codexCloud/host-error') return root.appendChild($(line('host', esc(p.message), 'unknown')))
  if (m.method === 'turn/started')   return root.appendChild($(line('turn', 'started')))
  if (m.method === 'turn/completed') {
    const t = p.turn || {}
    return root.appendChild($(line('turn', t.status === 'failed'
      ? '<span class="err">failed — ' + esc((t.error||{}).message).slice(0,300) + '</span>'
      : 'completed')))
  }
  if (m.method === 'thread/goal/updated') {
    const g = p.goal || {}
    return root.appendChild($(line('goal', esc(g.status) + (p.turnId ? '' : ' (set through the API)'))))
  }
  if (m.method === 'error') {
    const e = p.error || {}
    return root.appendChild($(line('error', esc(e.message).slice(0,300), 'err')))
  }
  if (m.method === 'warning') return root.appendChild($(line('warning', esc(p.message).slice(0,300), 'unknown')))
  if (m.method && m.method.startsWith('item/')) return renderItem(root, m, seen)
  if (m.id !== undefined && m.result) return // handshake replies are not worth a line
  if (m.method) return root.appendChild($(line(m.method, '', 'unknown')))
}

// Items arrive started, then updated, then completed. Only the completed form is
// worth keeping; the earlier ones replace themselves in place so a long turn
// does not print the same command three times.
function renderItem(root, m, seen) {
  const item = (m.params || {}).item || {}
  const d = item.details || item
  const key = item.id || item.itemId
  let html, kind = d.type || 'item'

  // app-server names item types in camelCase; the snake_case spellings belong to
  // the reduced projection \`codex exec --json\` emits. Both are accepted because
  // getting this wrong is silent -- every item falls through to the grey
  // unknown line and the page looks empty rather than broken.
  switch (d.type) {
    case 'agentMessage':
    case 'agent_message': html = esc(d.text); break
    case 'reasoning': {
      const r = d.text || (Array.isArray(d.summary) ? d.summary.join(' ') : d.summary) || ''
      if (!r) return
      html = '<details><summary>reasoning</summary>' + esc(r) + '</details>'; break
    }
    case 'commandExecution':
    case 'command_execution':
      html = esc(d.command) + (d.aggregatedOutput || d.output
        ? '<details><summary>output' + (d.exitCode!=null ? ' (exit ' + d.exitCode + ')' : '') + '</summary><pre>' +
          esc(d.aggregatedOutput || d.output).slice(0,4000) + '</pre></details>' : '')
      break
    case 'fileChange':
    case 'file_change':
      html = (d.changes || []).map(c => {
        const kind = typeof c.kind === 'object' ? (c.kind||{}).type : c.kind
        const diff = c.diff ? '<pre>' + esc(c.diff).slice(0,3000) + '</pre>' : ''
        return esc((kind||'') + ' ' + (c.path||'')) + diff
      }).join('<br>') || 'file change'
      break
    case 'todoList':
    case 'todo_list':
      html = '<ul class="todo">' + (d.items||[]).map(t =>
        '<li>' + (t.completed ? '✓ ' : '· ') + esc(t.text) + '</li>').join('') + '</ul>'
      break
    case 'mcpToolCall':
    case 'mcp_tool_call': html = esc((d.server||'') + '.' + (d.tool||'')) + ' — ' + esc(d.status||''); break
    case 'webSearch':
    case 'web_search':    html = 'search: ' + esc(d.query); break
    case 'error':         html = '<span class="err">' + esc(d.message) + '</span>'; break
    default:
      // Unknown on purpose: upstream adds item types, and a gap here should read
      // as "not rendered yet", never as a failure.
      return upsert(root, seen, key, line(kind, esc(JSON.stringify(d)).slice(0,240), 'unknown'))
  }
  upsert(root, seen, key, line(kind, html))
  if (d.type === 'todo_list' || d.type === 'todoList') {
    const t = document.getElementById('todo')
    if (t) t.innerHTML = html
  }
}

function upsert(root, seen, key, html) {
  const el = $(html)
  if (key && seen.has(key)) { seen.get(key).replaceWith(el); seen.set(key, el); return }
  root.appendChild(el)
  if (key) seen.set(key, el)
}

// ---- boot -------------------------------------------------------------

;(async () => {
  try {
    const me = await api('/whoami')
    document.getElementById('who').textContent = me.user + ' · ' + me.kind
  } catch (e) {
    document.getElementById('who').innerHTML = '<span class="err">' + esc(e.message) + '</span>'
    return
  }
  const hash = location.hash.slice(1)
  hash ? showTask(hash) : showList()
})()
</script></body></html>`;
