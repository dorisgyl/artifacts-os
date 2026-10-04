# rules

What every agent working for this owner must respect. Agents get a read-only
token for this repository; only the owner changes it, with plain git.

`rules.json` is read by the review workflow on every push. Each rule names the
`check` that enforces it (see `src/rules/check.ts` in the runtime).
