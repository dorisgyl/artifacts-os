# Artifacts-OS

An edge runtime for one person's own agent, built on Cloudflare Workers and
Artifacts.

You tell it what you need done, again and again — *"on the 1st of every month,
scan my credit card statements and find new subscriptions and price
increases"* — and it forks a template into a new Git repository, sends a few
agents to work on it at once, reviews what they push against your rules, and
runs the result on its own schedule. Every task is a repo, and every repo is an
app you keep.

Agents never talk to each other directly. They coordinate through Git:

- **Branches are the work.** Each agent works on its own branch.
- **Notes are the conversation.** Claims, reviews, and Jev's decisions are
  written as notes. Each writer has its own ref (`refs/notes/<kind>/<writer>`),
  so agents writing at the same time do not overwrite each other's notes. When
  two pushes to the same ref race, the losing push is retried.
- **Forks are the permission boundary.** An outside agent — Claude Code over
  MCP, or Codex in a container — gets its own fork of the app and a one-hour
  token for that fork, and nothing more.

> Built for Cloudflare's *Build the next Git platform* competition (October 2026).
> MIT licensed. See [`DESIGN.md`](DESIGN.md) for the full design and the decisions behind it.

## What happens when you type a sentence

1. **Route.** Jev (TypeSafe's typed decision model on Workers AI) picks a
   template. Its probabilities are written to `refs/notes/decision/jev`.
2. **Fork.** The template is forked into a new repo, `card-watch`.
3. **Plan.** The template's own `AGENTS.md` declares the lanes, for example
   *input* and *analysis*. The planner gives each lane to one agent on its own
   branch.
4. **Work.** Each edge agent is a Workflow. It clones the repo into memory with
   isomorphic-git, reads the other agents' intent notes, writes its own claim,
   asks the model for whole files, smoke-tests them, then pushes its branch and
   its notes together.
5. **Review.** Every push in the namespace starts a review Workflow. The review
   checks the change against the owner's `rules` repository: no network calls,
   only the agent's own paths, card numbers masked, no dependencies. The
   verdict becomes a review note.
6. **Run.** The app is loaded at a commit as a **Dynamic Worker with no
   network**. Its only door is a `REPO` capability, which reads this repo and
   the owner's memory and hands results back. A branch is live as soon as it is
   pushed: a preview is the same loader call with a different sha.
7. **Approve in the app.** A preview page carries an approval bar showing:
   - what changed;
   - what the rules found;
   - why the change was made;
   - a switch between the competing versions;
   - a Merge button.

   Losing attempts move to `archive/`, with an outcome note explaining why.

When a fix belongs in shared template code, it goes to the template instead.
The fix then fans out to every app built from that template, and Jev decides
how each app gets it:

| What the merge finds | What happens |
| --- | --- |
| A clean merge | Pushed for preview |
| A textual conflict | Resolved at the edge by the model |
| A merge that needs a shell (the app declares `npm test` as a gate) | Escalated to Codex in a container. The container gets its own fork and is destroyed afterwards. |

## Built, and designed but not built

The video calls out anything that is not built. This table is the same list.

| | Status |
| --- | --- |
| One-sentence app creation: route, fork, lanes, parallel edge agents, auto-merge on pass | built |
| Intent, telemetry, review, decision and outcome notes, one ref per writer | built |
| Rules review on every push (namespace-wide `cf.artifacts.repo.pushed` → Workflow) | built |
| Main guard (tokens are per repo, so a stray push to main is put back) | built |
| Apps as Dynamic Workers per commit, no network, `REPO` capability; app pages sandboxed (CSP, opaque origin) | built |
| Approval bar: previews, version switch, merge, archive of losers | built |
| Memory writes after a merge, with undo (a revert commit) | built |
| Template fix → new version tag → fan-out: clean / edge-resolved / container | built |
| Codex in a container: workspace fork, `npm test`, push back, playbook to `experience` | built |
| MCP: `request_app`, `open_workspace`, `status` | built |
| Console: lanes, Jev probabilities, meters, memory, event export | built |
| Mirror to a public Git remote with notes (`npm run mirror`) | built |
| `knowledge` repository (reference material the agent consults) | **designed, not built** |
| Email ingestion of statements (statements are uploaded in the Console) | **designed, not built** |
| Trace notes (`refs/notes/trace/*`) | **designed, not built** |

**Known limit.** App code runs with no network, so a Worker run cannot send
data anywhere. App *pages* are written by agents too. They are sandboxed into
an opaque origin with no access to your session or the API, but a page can
still navigate the browser to another site. The rules review catches the
straightforward attempts, not every obfuscated one, so treat a report page as
untrusted content.

The platform facts this design depends on are listed as D1 items. The D1
worker in `spikes/d1/` checks them against a real account. Until they have
been run there, treat the items in [CLAUDE.md](CLAUDE.md#d1) as the source of
truth for what is verified and what is not.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dorisgyl/artifacts-os)

**Requirements:**

- A Workers Paid plan. Artifacts, Dynamic Workers and Containers all need it.
- Node 22.18 or newer.

**Steps:**

```sh
npm install
npx wrangler login
npm run setup      # deploys, asks for secrets, explains Access and MCP
```

The deploy button has not yet been verified for this Worker's binding set
(D1 item 10). `npm run setup` is the supported path.

The first visit to the Console creates `rules`, `memory`, `experience` and
`tpl-scheduled-scan` in your Artifacts namespace.

**Configuration:**

- `MODEL` in `wrangler.jsonc` chooses the edge agents' model, served through AI
  Gateway's compatible endpoint. Provider keys stay at the gateway.
- If `MODEL` is not set, `FALLBACK_MODEL` runs on Workers AI.

**Access:** put Cloudflare Access in front of the Worker. In the dashboard, open
Settings → Domains & Routes and enable Cloudflare Access. This covers
workers.dev and every preview URL.

**Claude Code:** connect it over MCP with an Access service token. See
`npm run setup`, step 5.

## Try it

1. Open the Console and type a need.
2. Upload the simulated statements in `fixtures/statements/`, then press
   **Run now**.
3. Ask for a change, for example *"Streamly's price went up but the report
   missed it"*. The `merchant-normalization` playbook in `experience` turns that
   into three competing attempts:
   - The `enrich` attempt is rejected for calling out to the network.
   - Preview the other two and merge one.
4. Upload `maple-2026-11.csv`. The quoted comma in `"ACME, INC."` breaks the
   template's CSV reader. Ask for that to be fixed: it is fixed in the
   template, and the fix fans out to every app built from it.

## Read the agents' notes yourself

```sh
git clone <mirror> card-watch && cd card-watch
git fetch origin 'refs/notes/*:refs/notes/*'
git log --notes='refs/notes/*'
```

## Layout

```
wrangler.jsonc        one Worker: every binding, the cron, the push trigger
src/index.ts          routes: / (Console) /api /apps /mcp; scheduled()
src/control/          coordinator DO, registry DO, planner, Jev, memory, escalation, setup
src/agents/           AgentRun, ReviewOnPush, NewApp, FanOut workflows; edge agent; LLM
src/git/              isomorphic-git in memory; notes conventions
src/apps/             Dynamic Worker host, REPO capability, approval bar, merge
src/rules/check.ts    the rules review
src/mcp/server.ts     MCP over Streamable HTTP
src/container/        the container task host for long-running agent runs
templates/            tpl-scheduled-scan, written into Artifacts on first run
seeds/                rules, memory, experience
console/              Preact + htm, no build step
spikes/d1/            the D1 verification worker
fixtures/statements/  simulated statements for the demo
```

## Tests

```sh
npm test     # git over real Smart HTTP, rules, planner and cron, and the template as a Dynamic Worker in workerd
npm run check
```
