# Conventions for anyone (or any agent) changing this repository

These are the runtime's own conventions. The runtime's agents follow them in
the app repositories they work on; follow them here too.

## Git

- Commit messages are one line. The reason for a change goes in a note, not in
  the commit.
- Notes live at `refs/notes/<kind>/<writer>`, with one writer per ref.
  - Kinds: `intent`, `telemetry`, `review`, `decision`, `outcome`, `trace`.
  - Shapes: `src/git/notes.ts`.
- Branch prefixes say who is changing what:

  | Prefix | Used for |
  | --- | --- |
  | `agent/` | lanes of a new app |
  | `attempt/` | competing strategies |
  | `change/` | a single change |
  | `ext/<agent>/` | work brought in from a workspace fork |
  | `fix/` | template fixes |
  | `upgrade/tpl-<tag>` | fan-out |
  | `playbook/` | `experience` |
  | `archive/` | losers, kept |

- Workspace forks are named `<app>.ws-<agent>-<id>`.

## Code

- **TypeScript in `src/`.** Use only syntax Node can strip, so tests run with
  no build step: no enums, and no parameter properties.
- **Plain JavaScript in `src/container/` and `templates/`.** Template code is
  loaded as-is by the Worker Loader, so it has no dependencies and uses only
  relative imports.
- **Values that cross a Durable Object RPC or a Workflow step are typed as
  `Json`** (`src/lib/json.ts`), not `unknown`.
- **Every token is minted by a coordinator.** Use `RepoCoordinator.issue`,
  never `createToken` directly. That way every token is recorded and can be
  revoked when its lane ends.
- **The runtime moves `main` only after calling `expectMain`.** Any other move
  of `main` is put back by the main guard.

## Tests

`npm test` runs four groups of tests:

- the git layer, over a real Smart HTTP server (`git http-backend`);
- the rules review;
- the planner and cron parsing;
- the template, loaded as a Dynamic Worker in workerd through `wrangler dev`.
