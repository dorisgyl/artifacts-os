// git-notes conventions.
//
// A commit says what changed in one line. Everything agents say to each other
// -- who claimed what, what the reviewer found, why Jev escalated -- is a note.
// Each notes ref has exactly one writer, named `<kind>/<writer>`, so agents
// pushing notes at the same moment never reject each other's pushes.

import type { Author, Remote, WorkingCopy } from "./ops.ts";

export type NoteKind = "intent" | "telemetry" | "review" | "decision" | "outcome" | "trace";

export const notesRef = (kind: NoteKind, writer: string) => "refs/notes/" + kind + "/" + writer;

export function parseNotesRef(ref: string): { kind: NoteKind; writer: string } | null {
  const m = ref.match(/^refs\/notes\/(intent|telemetry|review|decision|outcome|trace)\/(.+)$/);
  return m ? { kind: m[1] as NoteKind, writer: m[2] } : null;
}

export interface IntentNote {
  v: 1;
  agent: string;
  status: "claimed" | "started" | "pushed" | "blocked" | "done";
  direction: string;
  strategy?: string;
  branch?: string;
  /** "all", or the id of the one agent this is addressed to. */
  to: string;
  at: string;
}

export interface TelemetryNote {
  v: 1;
  agent: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  ms: number;
  attempts: number;
}

export interface ReviewNote {
  v: 1;
  auditor: string;
  verdict: "pass" | "reject";
  rulesCommit: string;
  findings: { rule: string; path?: string; detail: string }[];
}

export interface DecisionNote {
  v: 1;
  by: string;
  decision: string;
  reason: string;
  probabilities?: Record<string, number>;
  to: string;
}

export interface OutcomeNote {
  v: 1;
  source: string;
  outcome: "merged" | "archived" | "blocked" | "tests-passed" | "tests-failed" | "guard-restored";
  detail: string;
}

export interface NoteWrite {
  kind: NoteKind;
  writer: string;
  oid: string;
  body: unknown;
}

/**
 * Attach notes and push their refs. The caller has already fetched any notes
 * refs it is about to extend, so each push is a fast-forward of a ref only
 * this writer moves; `force` covers a first write after a fresh clone.
 */
export async function writeNotes(
  wc: WorkingCopy,
  remote: Remote,
  notes: NoteWrite[],
  author: Author,
): Promise<string[]> {
  const pushed = new Set<string>();
  for (const n of notes) {
    const ref = notesRef(n.kind, n.writer);
    try {
      await wc.fetchRef(remote, ref, ref);
    } catch {
      /* first note on this ref */
    }
    await wc.addNote(ref, n.oid, n.body, author);
    pushed.add(ref);
  }
  for (const ref of pushed) await wc.push(remote, ref, { force: true });
  return [...pushed];
}

/** Every note attached to `oid`, across all fetched notes refs. */
export async function notesFor(
  wc: WorkingCopy,
  refs: string[],
  oid: string,
): Promise<{ ref: string; kind: NoteKind; writer: string; body: unknown }[]> {
  const out = [];
  for (const ref of refs) {
    const parsed = parseNotesRef(ref);
    if (!parsed) continue;
    const text = await wc.readNote(ref, oid);
    if (text === null) continue;
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain-text notes are allowed: Claude Code may write them by hand */
    }
    out.push({ ref, ...parsed, body });
  }
  return out;
}
