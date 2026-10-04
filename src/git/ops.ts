// Git, from inside a Worker.
//
// Artifacts has no write API: every commit, merge and note is made here with
// isomorphic-git over Smart HTTP and pushed like any other client would. That
// is deliberate, not a workaround -- the runtime is one more Git client, with
// no privileged path the agents do not also have.

import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memfs.ts";

export interface Remote {
  /** HTTPS remote, as returned by ArtifactsRepo.info().remote. */
  url: string;
  /** Plaintext token, with or without its `?expires=` suffix. */
  token: string;
}

export interface Author {
  name: string;
  email: string;
}

export const RUNTIME: Author = { name: "artifacts-os", email: "runtime@artifacts-os.invalid" };
export const OWNER_VIA_RUNTIME: Author = { name: "owner", email: "owner@artifacts-os.invalid" };
export const agentAuthor = (agentId: string): Author => ({
  name: agentId,
  email: agentId + "@agents.artifacts-os.invalid",
});

const DIR = "/repo";
const enc = new TextEncoder();
const dec = new TextDecoder();

export function secretOf(token: string): string {
  return token.split("?expires=")[0];
}

function auth(remote: Remote) {
  return () => ({ username: "x", password: secretOf(remote.token) });
}

export interface ChangedFile {
  path: string;
  type: "add" | "modify" | "delete";
}

export class MergeConflict extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super("merge conflict in " + files.join(", "));
    this.files = files;
  }
}

/**
 * One clone, in memory. Cheap enough to make per step: the template-sized
 * repositories this runtime works with are a few hundred kilobytes.
 */
export class WorkingCopy {
  readonly fs = new MemoryFS();
  readonly dir = DIR;
  private cache: object = {};

  private base() {
    return { fs: this.fs, dir: this.dir, cache: this.cache };
  }

  static async clone(
    remote: Remote,
    opts: { ref?: string; depth?: number; full?: boolean } = {},
  ): Promise<WorkingCopy> {
    const wc = new WorkingCopy();
    await git.clone({
      ...wc.base(),
      http,
      url: remote.url,
      ref: opts.ref,
      singleBranch: true,
      depth: opts.full ? undefined : opts.depth || 1,
      onAuth: auth(remote),
    });
    return wc;
  }

  /** Start from nothing: used once per seed repository. */
  static async init(branch = "main"): Promise<WorkingCopy> {
    const wc = new WorkingCopy();
    await git.init({ ...wc.base(), defaultBranch: branch });
    return wc;
  }

  /**
   * Bring one ref from any remote into this clone, under `localRef`.
   * Used for agent branches, template tags and notes alike.
   */
  async fetchRef(
    remote: Remote,
    remoteRef: string,
    localRef: string,
    opts: { depth?: number; full?: boolean } = {},
  ): Promise<string | null> {
    const res = await git.fetch({
      ...this.base(),
      http,
      url: remote.url,
      ref: remoteRef,
      remoteRef,
      singleBranch: true,
      tags: false,
      depth: opts.full ? undefined : opts.depth,
      onAuth: auth(remote),
    });
    if (!res.fetchHead) return null;
    await git.writeRef({ ...this.base(), ref: localRef, value: res.fetchHead, force: true });
    return res.fetchHead;
  }

  async listRemoteRefs(remote: Remote, prefix: string): Promise<{ ref: string; oid: string }[]> {
    const refs = await git.listServerRefs({
      http,
      url: remote.url,
      prefix,
      protocolVersion: 2,
      onAuth: auth(remote),
    });
    return refs.map((r) => ({ ref: r.ref, oid: r.oid }));
  }

  async resolve(ref: string): Promise<string> {
    return git.resolveRef({ ...this.base(), ref });
  }

  async checkout(ref: string, opts: { create?: string } = {}): Promise<void> {
    if (opts.create) {
      await git.branch({ ...this.base(), ref: opts.create, object: ref, checkout: false, force: true });
      await git.checkout({ ...this.base(), ref: opts.create, force: true });
      return;
    }
    await git.checkout({ ...this.base(), ref, force: true });
  }

  async currentBranch(): Promise<string | undefined> {
    return (await git.currentBranch({ ...this.base(), fullname: false })) || undefined;
  }

  async read(path: string): Promise<string | null> {
    try {
      return (await this.fs.readFile(this.dir + "/" + path, "utf8")) as string;
    } catch {
      return null;
    }
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    const full = this.dir + "/" + path;
    await this.fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await this.fs.writeFile(full, content);
    await git.add({ ...this.base(), filepath: path });
  }

  async remove(path: string): Promise<void> {
    try {
      await this.fs.unlink(this.dir + "/" + path);
    } catch {
      /* already gone */
    }
    await git.remove({ ...this.base(), filepath: path });
  }

  async files(): Promise<string[]> {
    return this.fs.listFiles(this.dir);
  }

  /** Files at a commit, read from the object store rather than the worktree. */
  async readAt(oid: string, path: string): Promise<string | null> {
    try {
      const { blob } = await git.readBlob({ ...this.base(), oid, filepath: path });
      return dec.decode(blob);
    } catch {
      return null;
    }
  }

  async commit(message: string, author: Author, parents?: string[]): Promise<string> {
    return git.commit({
      ...this.base(),
      message,
      author: { ...author, timestamp: Math.floor(Date.now() / 1000) },
      parent: parents,
    });
  }

  async push(
    remote: Remote,
    ref: string,
    opts: { remoteRef?: string; force?: boolean; delete?: boolean } = {},
  ): Promise<void> {
    const res = await git.push({
      ...this.base(),
      http,
      url: remote.url,
      ref,
      remoteRef: opts.remoteRef || ref,
      force: opts.force,
      delete: opts.delete,
      onAuth: auth(remote),
    });
    if (!res.ok) {
      const why = Object.entries(res.refs || {})
        .map(([k, v]) => k + ": " + (v as { error?: string }).error)
        .join("; ");
      throw new Error("push rejected: " + (res.error || why));
    }
  }

  /** Delete a ref on the remote; the local clone need not have it. */
  async deleteRemoteRef(remote: Remote, remoteRef: string): Promise<void> {
    await this.push(remote, "HEAD", { remoteRef, delete: true });
  }

  // ---- notes -----------------------------------------------------------

  async addNote(notesRef: string, oid: string, note: unknown, author: Author): Promise<string> {
    const text = typeof note === "string" ? note : JSON.stringify(note, null, 2) + "\n";
    return git.addNote({
      ...this.base(),
      ref: notesRef,
      oid,
      note: enc.encode(text),
      force: true,
      author: { ...author, timestamp: Math.floor(Date.now() / 1000) },
    });
  }

  async readNote(notesRef: string, oid: string): Promise<string | null> {
    try {
      const bytes = await git.readNote({ ...this.base(), ref: notesRef, oid });
      return dec.decode(bytes);
    } catch {
      return null;
    }
  }

  async listNotes(notesRef: string): Promise<{ target: string; note: string }[]> {
    try {
      return await git.listNotes({ ...this.base(), ref: notesRef });
    } catch {
      return [];
    }
  }

  /** Fetch every notes ref the remote has under `prefix`. Returns the refs. */
  async fetchNotes(remote: Remote, prefix = "refs/notes/"): Promise<string[]> {
    const refs = await this.listRemoteRefs(remote, prefix);
    const got: string[] = [];
    for (const r of refs) {
      if (await this.fetchRef(remote, r.ref, r.ref)) got.push(r.ref);
    }
    return got;
  }

  // ---- merge and diff ----------------------------------------------------

  /**
   * Three-way merge `theirs` into the checked-out `ours`. On conflict the
   * worktree keeps the conflict markers and MergeConflict names the files;
   * the caller resolves them and calls `commitMerge`.
   */
  async merge(ours: string, theirs: string, message: string, author: Author): Promise<string> {
    await this.checkout(ours);
    try {
      const res = await git.merge({
        ...this.base(),
        ours,
        theirs,
        message,
        abortOnConflict: false,
        author: { ...author, timestamp: Math.floor(Date.now() / 1000) },
      });
      if (!res.oid) throw new Error("merge produced no commit");
      // merge() moves the branch but not the worktree; bring it along so the
      // caller reads the merged files.
      await this.checkout(ours);
      return res.oid;
    } catch (e) {
      const err = e as { code?: string; data?: { filepaths?: string[] } };
      if (err.code === "MergeConflictError") {
        throw new MergeConflict((err.data && err.data.filepaths) || []);
      }
      throw e;
    }
  }

  /** Finish a conflicted merge once every conflicted file has been rewritten. */
  async commitMerge(ours: string, theirsOid: string, message: string, author: Author): Promise<string> {
    const oursOid = await this.resolve(ours);
    // A conflicted merge leaves the worktree as the merge wrote it, but does
    // not apply deletions: a file theirs deleted (and ours left alone) must go.
    const base = await this.mergeBase(oursOid, theirsOid);
    if (base) {
      const oursChanged = new Set((await this.changed(base, oursOid)).map((c) => c.path));
      for (const c of await this.changed(base, theirsOid)) {
        if (c.type === "delete" && !oursChanged.has(c.path)) await this.remove(c.path);
      }
    }
    for (const path of await this.files()) {
      await git.add({ ...this.base(), filepath: path });
    }
    return this.commit(message, author, [oursOid, theirsOid]);
  }

  async changed(fromOid: string, toOid: string): Promise<ChangedFile[]> {
    const out: ChangedFile[] = [];
    await git.walk({
      ...this.base(),
      trees: [git.TREE({ ref: fromOid }), git.TREE({ ref: toOid })],
      map: async (filepath, entries) => {
        if (filepath === ".") return true;
        const [a, b] = entries || [];
        const ta = a ? await a.type() : null;
        const tb = b ? await b.type() : null;
        if (ta === "tree" || tb === "tree") return true;
        const oa = a ? await a.oid() : null;
        const ob = b ? await b.oid() : null;
        if (oa === ob) return null;
        out.push({ path: filepath, type: !oa ? "add" : !ob ? "delete" : "modify" });
        return true;
      },
    });
    return out;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const bases = await git.findMergeBase({ ...this.base(), oids: [a, b] });
    return bases.length ? bases[0] : null;
  }

  async tag(name: string, oid: string): Promise<void> {
    await git.tag({ ...this.base(), ref: name, object: oid, force: true });
  }

  async log(ref: string, depth = 20) {
    return git.log({ ...this.base(), ref, depth });
  }
}

export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text);
}
