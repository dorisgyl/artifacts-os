# codex-cloud

Long-running [Codex](https://github.com/openai/codex) tasks on Cloudflare — give it
a goal and a repo, close your laptop.

> **Unofficial.** Not affiliated with OpenAI. This is a third-party host for their
> open-source coding agent, which is consumed as released binaries and never
> patched.

Deploy it to **your own** Cloudflare account. You bring the account and the OpenAI
credentials; nothing here asks you to sign up for anything of ours.

## What this is, and what it is not

A task host, not a chat window. You submit an objective and a repository, the agent
works on it unattended for as long as it takes, and it stops when the goal is met,
when it is genuinely stuck, or when it runs out of budget. You come back to a branch
and a recording.

**Interactive chat is deliberately absent.** Running an agent in a browser tab that
talks to a container three network hops away is slower and more expensive than
running it on your own machine, and it buys nothing: the only thing a cloud host
actually gives you is *work that continues while you are not there*. Use the CLI
locally for conversation; use this for the forty-minute job.

## Status: early, and honest about it

Verified against a real deployment on 2026-08-21.

| | |
|---|---|
| `codex app-server` running in a Cloudflare container | yes — boots in ~10s, pulled at start from the pinned release |
| A host Durable Object driving it over a FIFO and a file | yes — survives its own eviction, reattaches by byte offset |
| Frame log — the notification stream, recorded and replayable | yes |
| Task lifecycle — dispatch, run, stop, preserve the scene | yes — driven by the upstream goal state machine |
| Cloudflare Access identity and per-user sharding | code complete, **unverified against a real Access application** |
| Web UI — dispatch, task list, watch a running task | yes |
| Metering — concurrency, container seconds, turns per day | yes |
| A real model turn, through AI Gateway with the key stored at the gateway | yes |
| **An agent that finishes a piece of work** | **yes** — reads the repo, edits a file, verifies its own diff, reaches `complete` |
| git out — pushing the branch back | **no** — the branch is created and committed locally, never pushed |
| Restarting a stopped task with a rewritten objective | yes for the conversation — `thread/resume` accepts the restored rollout and the thread id survives; **no** for the working tree |

The first completed task took 41 seconds end to end: boot, clone, one turn, and
a goal that passed Codex's own completion audit. The agent looked for `rg`,
found it missing, fell back to `find`, read the file, edited it, and then ran
`git diff --check` on its own work before declaring done.

**Restart is only half-correct until pushing works.** A stopped task keeps its
rollout, so restarting it brings the conversation back and upstream treats it as
a fresh judgement. The working tree does not come back: the branch was committed
inside a container that no longer exists, and without a credential it was never
pushed anywhere. The agent resumes believing it edited files that are no longer
there. Codex's own continuation prompt tells it to treat the worktree as
authoritative and inspect before relying on memory, which softens this, but the
honest statement is that restart becomes correct when `git push` does.

What is still missing is the last mile: the work is committed to a branch inside
a container that then goes away. Until `git push` is wired, a finished task
produces a recording and a diff you can read, not a branch you can merge.

## How a task runs

```
browser / API
     │  HTTPS, behind Cloudflare Access
     ▼
edge Worker                  V8 isolate — identity, routing, metering
     │
     ▼
host Durable Object          one per task; frame log, rollout, lifecycle
     │  ctx.container.exec(["codex","app-server","--stdio"])
     ▼
container                    a VM running our image, alive only while the task is
     └─ codex app-server     the agent loop, plus git and the toolchain
```

One task means one Durable Object, one container, one `codex` thread. Tasks never
share a filesystem: two jobs against the same repository get two checkouts, because
the alternative is two agents silently overwriting each other's edits.

The container exists only while the task runs. There is no idle state to pay for and
no warm pool to keep alive.

## How a task stops

The stop semantics are Codex's own, not something invented here. A task's state *is*
its goal state:

| | set by | resumable |
|---|---|---|
| `complete` | the model, after an evidence-by-evidence completion audit | terminal |
| `blocked` | the model, only after the same blocker recurs for three consecutive goal turns | **yes** |
| `budget_limited` | the system, when the token budget is spent | terminal |
| `usage_limited` | the system, on an account limit | yes |
| `paused` | **you** | yes |
| `active` | | |

Upstream enforces the division: the model may only ever mark a goal `complete` or
`blocked`, and it is explicitly forbidden from declaring completion because the
budget is running out. Pausing is yours alone.

There is no "it went the wrong way" state, because only a person can judge that. That
judgement is expressed by pausing the task, rewriting the objective, and restarting —
which keeps the work already done, and which upstream treats as a fresh judgement:
a resumed goal starts its blocked audit over from zero.

**Every task requires a token budget.** `budget_limited` is the only hard brake a
long-running agent has. A task with no budget is bounded by nothing but your OpenAI
bill.

**A blocked task is never retried automatically.** Reaching `blocked` already means
the same obstacle survived three consecutive turns of trying; retrying it in a loop
converts a careful judgement into an expensive one.

## What survives

| Kept, in the Durable Object | Gone, with the container |
|---|---|
| the dispatch — repo, branch, objective, budget | `/workspace`, the working copy |
| the frame log | the agent process and its memory |
| the rollout, so a blocked task can resume | background processes it started |
| the goal snapshot | |

Code persists in **git**, not here: a task clones at start and commits to its working
branch before stopping. Anything uncommitted when the container goes away is gone,
so a long task should commit at milestones rather than saving it all for the end.

Stopping is therefore never just "stop the container" — the working tree is committed
and pushed, the rollout and goal snapshot are written, and only then does the
container go away. None of that can be reconstructed afterwards.

## Deploy

Two Workers, in dependency order. The edge binds to the host's Durable Object
namespace by script name, so the host has to exist first.

```bash
git clone <this repo> && cd codex-cloud
npm install

npm run deploy:host   # the task objects and their containers; no route
npm run deploy:edge   # the only unit reachable from the internet
```

Put a hostname you control in front of `codex-edge` and put nothing in front of
`codex-host` — it runs an agent with unrestricted access to its own container.

Until Access is configured the deployment refuses every request with
`503 access-not-configured`, including the UI. That is deliberate: an agent with
a shell, reachable by anyone who finds the URL, is worse than an outage.

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN --config units/edge/wrangler.jsonc
npx wrangler secret put ACCESS_AUD         --config units/edge/wrangler.jsonc
```

Both are **secrets, not vars**: a var of the same name silently overrides a
secret, so one deployment's values baked into the config would point every clone
at somebody else's Access application.

### Uninstall

`wrangler delete` leaves the container applications behind, still billable.
They have to go separately:

```bash
npx wrangler containers list
npx wrangler containers delete <id>
```

## Requirements

- **OpenAI credentials.** Codex removed the `chat` wire API; only the Responses API
  is supported, so an arbitrary "OpenAI-compatible" endpoint will not work.

  The recommended shape is **AI Gateway with the provider key stored at the
  gateway**. Then the container carries a gateway token instead of an OpenAI
  key: the agent can still read whatever is in its own container, but what it
  can read is scoped to one gateway and revocable on its own, rather than being
  spend authority on an OpenAI account. Set `CF_ACCOUNT_ID` and
  `AI_GATEWAY_TOKEN` on the host and the routing follows automatically.

  Without those two, set `OPENAI_API_KEY` instead and traffic goes straight to
  OpenAI — simpler, and the key is in the container.
- **A Cloudflare account on the Workers Paid plan** ($5/month), with Containers.
- **Cloudflare Access**, for identity. Every Durable Object name is derived from
  verified Access claims, so a client cannot address another user's task.
- **A hostname you control.** Do not deploy on `*.workers.dev`.
- A container image — either built from the `Dockerfile` here, or the published one
  pulled straight from a public registry, which needs no Docker on your side.

## Cost

Containers bill for provisioned memory and disk **for as long as they run**, whether
or not the agent is doing anything, and CPU on top of that for actual use. A
`standard-1` instance (½ vCPU, 4 GiB, 8 GB) costs roughly **$0.038 per hour** idle-
but-running, and the Workers Paid plan includes 25 GiB-hours per month — about
**6¼ container-hours** at that size.

This is the reason there is no chat mode. A conversation spends most of its wall
clock waiting for a human to read and type, and a container billed through that wait
is paying for nothing. A task keeps the container busy from start to finish.

Cold start is 1–3 seconds, and a clone on top of that; amortised over a long task it
does not matter, which it would not be in a chat.

## Design notes

`docs/adr/` records the decisions and, more usefully, the rejected alternatives.
`CONTEXT.md` is the glossary — both are working documents and are not published.

## Licence

MIT. See `LICENSE`. Codex itself is Apache-2.0 and is not redistributed here.
