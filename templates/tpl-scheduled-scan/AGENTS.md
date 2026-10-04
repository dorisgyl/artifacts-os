# tpl-scheduled-scan — how to work on this app

This repository is a personal app. It runs on Artifacts-OS: the runtime loads
the code at a commit as a Dynamic Worker with **no network access** and calls
`run()` on the schedule in `app.json`. Everything the app knows comes from
this repository and from the read-only `memory` repository, through
`env.REPO`. Everything it produces is a snapshot the runtime commits for it.

## Rules every agent follows

1. **No npm dependencies.** The runtime loads these files as they are; there is
   no bundler. Write plain ES modules. Import only relative paths and
   `cloudflare:workers`.
2. **Change only `agentPaths`** (see `app.json`). Everything in
   `templatePaths` belongs to the template and changes only by a fix pushed to
   the template repository, which then fans out to every app built from it.
   If you find a bug there, say so in your intent note and change it in the
   template, not here.
3. **No network.** `fetch()` throws inside the app. A strategy that needs an
   outside service is rejected by review before it runs.
4. **Card and account numbers are kept as the last four digits only**
   (`****1234`). Never write a full number to a file, a snapshot or a note.
5. **Links are relative.** Previews are served under
   `/apps/<repo>/@<branch>/`, the live app under `/apps/<repo>/`.
6. Commit messages are one line. Why you made a change goes in your intent
   note (`refs/notes/intent/<your-agent-id>`), not in the commit.

## The contract between parts

Every adapter turns one statement format into `Transaction` objects
(`src/types.js`):

```js
{ date: "2026-09-14", amount: 18.99, currency: "CAD",
  merchant: "STREAMLY*PREMIUM 800-555", account: "****4417", source: "data/statements/maple-2026-09.csv" }
```

`amount` is positive for money spent. That shape is the boundary that lets two
agents work at once: one writes adapters and normalisation, one writes
detection and the report, and neither waits for the other.

## Lanes

The planner splits a new app into these lanes. Each lane is one agent on one
branch.

- **input** — `src/adapters/**`, `src/normalize.js`, `tests/fixtures/**`,
  adapter tests. Parse every statement format in `data/statements/` into
  `Transaction`s; normalise merchant names, using
  `memory/merchant-aliases.json` when it has an entry.
- **analysis** — `src/detect.js`, `src/report.js`, `config.json`, detection
  tests. Find new subscriptions and price increases; render the report.

## Tests

`npm test` runs `tests/*.test.js` with the tiny harness in `tests/harness.js`
(Node, no dependencies). An app may declare `"gates": {"beforeMerge":
["npm test"]}`; then its changes are not merged until the tests pass in a
container.
