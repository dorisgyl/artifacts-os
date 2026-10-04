import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startGitServer, type GitServer } from "./helpers/git-server.ts";
import { WorkingCopy, MergeConflict, hasConflictMarkers, RUNTIME, agentAuthor } from "../src/git/ops.ts";
import { writeNotes, notesFor, notesRef } from "../src/git/notes.ts";

let srv: GitServer;
const remote = (name: string) => ({ url: srv.url(name), token: "art_v1_test?expires=0" });

before(async () => {
  srv = await startGitServer();
});
after(async () => {
  await srv.close();
});

async function seed(name: string, files: Record<string, string>) {
  srv.create(name);
  const wc = await WorkingCopy.init();
  for (const [p, c] of Object.entries(files)) await wc.write(p, c);
  const oid = await wc.commit("Seed " + name, RUNTIME);
  await wc.push(remote(name), "main");
  return oid;
}

test("clone, commit on a branch, push, and read back", async () => {
  await seed("app1", { "src/a.js": "export const a = 1;\n", "app.json": "{}\n" });
  const wc = await WorkingCopy.clone(remote("app1"), { ref: "main" });
  assert.deepEqual(await wc.files(), ["app.json", "src/a.js"]);
  await wc.checkout("main", { create: "agent/input" });
  await wc.write("src/b.js", "export const b = 2;\n");
  const oid = await wc.commit("Add b", agentAuthor("agent-input"));
  await wc.push(remote("app1"), "agent/input");

  const again = await WorkingCopy.clone(remote("app1"), { ref: "agent/input" });
  assert.equal(await again.resolve("HEAD"), oid);
  assert.equal(await again.read("src/b.js"), "export const b = 2;\n");
});

test("notes: one ref per writer, pushed and fetched back", async () => {
  const head = await seed("app2", { "x.txt": "x\n" });
  const wc = await WorkingCopy.clone(remote("app2"));
  await writeNotes(
    wc,
    remote("app2"),
    [
      { kind: "intent", writer: "agent-a", oid: head, body: { v: 1, status: "claimed", to: "all" } },
      { kind: "intent", writer: "agent-b", oid: head, body: { v: 1, status: "claimed", to: "all" } },
    ],
    RUNTIME,
  );
  // a second writer, from a separate clone, never conflicts with the first
  const other = await WorkingCopy.clone(remote("app2"));
  await writeNotes(
    other,
    remote("app2"),
    [{ kind: "review", writer: "auditor", oid: head, body: { v: 1, verdict: "pass" } }],
    RUNTIME,
  );

  const reader = await WorkingCopy.clone(remote("app2"));
  const refs = await reader.fetchNotes(remote("app2"));
  assert.deepEqual(refs.sort(), [
    notesRef("intent", "agent-a"),
    notesRef("intent", "agent-b"),
    notesRef("review", "auditor"),
  ]);
  const notes = await notesFor(reader, refs, head);
  assert.equal(notes.length, 3);
  assert.deepEqual(
    notes.find((n) => n.writer === "auditor")!.body,
    { v: 1, verdict: "pass" },
  );
});

test("three-way merge: clean, then a conflict with markers, then resolved", async () => {
  await seed("app3", {
    "src/csv.js": "export function split(line) {\n  return line.split(',');\n}\n",
    "src/other.js": "export const o = 1;\n",
  });
  const r = remote("app3");

  // a clean change on one branch
  const a = await WorkingCopy.clone(r, { full: true });
  await a.checkout("main", { create: "attempt/one" });
  await a.write("src/other.js", "export const o = 2;\n");
  await a.commit("Change other", RUNTIME);
  await a.push(r, "attempt/one");

  // a conflicting pair of edits to the same function
  const b = await WorkingCopy.clone(r, { full: true });
  await b.write("src/csv.js", "export function split(line) {\n  return line.split(';');\n}\n");
  await b.commit("Semicolon customisation", RUNTIME);
  await b.push(r, "main");

  const c = await WorkingCopy.clone(r, { full: true, ref: "main" });
  await c.fetchRef(r, "refs/heads/attempt/one", "refs/heads/attempt/one", { full: true });
  const merged = await c.merge("main", "attempt/one", "Merge attempt/one", RUNTIME);
  assert.ok(merged);
  assert.equal(await c.read("src/other.js"), "export const o = 2;\n");
  assert.equal(await c.read("src/csv.js"), "export function split(line) {\n  return line.split(';');\n}\n");

  // now a template fix that touches the same line
  const t = await WorkingCopy.clone(r, { full: true });
  await t.checkout((await t.log("main", 50)).at(-1)!.oid, { create: "fix/csv" });
  await t.write("src/csv.js", "export function split(line) {\n  return parseQuoted(line, ',');\n}\n");
  const fixOid = await t.commit("Handle quoted commas", RUNTIME);
  await t.push(r, "fix/csv");

  const d = await WorkingCopy.clone(r, { full: true, ref: "main" });
  await d.fetchRef(r, "refs/heads/fix/csv", "refs/heads/fix/csv", { full: true });
  await assert.rejects(
    d.merge("main", "fix/csv", "Merge template fix", RUNTIME),
    (e: unknown) => e instanceof MergeConflict && e.files.includes("src/csv.js"),
  );
  const conflicted = (await d.read("src/csv.js"))!;
  assert.ok(hasConflictMarkers(conflicted));

  await d.write("src/csv.js", "export function split(line) {\n  return parseQuoted(line, ';');\n}\n");
  const resolved = await d.commitMerge("main", fixOid, "Merge template fix (resolved at the edge)", RUNTIME);
  await d.push(r, "main");
  const log = await d.log("main", 3);
  assert.equal(log[0].oid, resolved);
  assert.equal(log[0].commit.parent.length, 2);
});

test("changed() lists adds, modifies and deletes between two commits", async () => {
  const first = await seed("app4", { "a.txt": "1\n", "b.txt": "1\n" });
  const wc = await WorkingCopy.clone(remote("app4"), { full: true });
  await wc.write("a.txt", "2\n");
  await wc.remove("b.txt");
  await wc.write("dir/c.txt", "3\n");
  const second = await wc.commit("Change", RUNTIME);
  const ch = await wc.changed(first, second);
  assert.deepEqual(
    ch.sort((x, y) => x.path.localeCompare(y.path)),
    [
      { path: "a.txt", type: "modify" },
      { path: "b.txt", type: "delete" },
      { path: "dir/c.txt", type: "add" },
    ],
  );
});

test("archive: a branch moved under archive/ and deleted in place", async () => {
  await seed("app5", { "a.txt": "1\n" });
  const r = remote("app5");
  const wc = await WorkingCopy.clone(r);
  await wc.checkout("main", { create: "attempt/rules" });
  await wc.write("a.txt", "rules\n");
  const oid = await wc.commit("Rules attempt", RUNTIME);
  await wc.push(r, "attempt/rules");

  const ar = await WorkingCopy.clone(r);
  await ar.fetchRef(r, "refs/heads/attempt/rules", "refs/heads/archive/attempt/rules");
  await ar.push(r, "refs/heads/archive/attempt/rules");
  await ar.deleteRemoteRef(r, "refs/heads/attempt/rules");
  const refs = await ar.listRemoteRefs(r, "refs/heads/");
  assert.deepEqual(
    refs.map((x) => x.ref).sort(),
    ["refs/heads/archive/attempt/rules", "refs/heads/main"],
  );
  assert.equal(refs.find((x) => x.ref.includes("archive"))!.oid, oid);
});
