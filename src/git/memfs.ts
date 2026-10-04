// An in-memory filesystem with exactly the surface isomorphic-git uses.
//
// A Worker has no disk, so every clone an agent makes lives in one of these
// and disappears with the request or workflow step that made it. That is the
// point: the only durable copy of anything is the one pushed to Artifacts.

type Node =
  | { kind: "file"; data: Uint8Array; mode: number; mtimeMs: number; ino: number }
  | { kind: "dir"; mode: number; mtimeMs: number; ino: number }
  | { kind: "link"; target: string; mode: number; mtimeMs: number; ino: number };

function fsError(code: string, path: string): Error {
  const e = new Error(code + ": " + path) as Error & { code: string };
  e.code = code;
  return e;
}

function norm(path: string): string {
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return "/" + parts.join("/");
}

function parent(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

class Stats {
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid = 1;
  gid = 1;
  dev = 1;
  constructor(node: Node) {
    this.type = node.kind === "link" ? "symlink" : node.kind;
    this.mode = node.mode;
    this.size = node.kind === "file" ? node.data.byteLength : 0;
    this.ino = node.ino;
    this.mtimeMs = node.mtimeMs;
    this.ctimeMs = node.mtimeMs;
  }
  isFile() {
    return this.type === "file";
  }
  isDirectory() {
    return this.type === "dir";
  }
  isSymbolicLink() {
    return this.type === "symlink";
  }
}

export class MemoryFS {
  private nodes = new Map<string, Node>();
  private nextIno = 1;
  readonly promises: MemoryFS;

  constructor() {
    this.nodes.set("/", { kind: "dir", mode: 0o40755, mtimeMs: Date.now(), ino: this.nextIno++ });
    this.promises = this;
  }

  private get(path: string): Node | undefined {
    return this.nodes.get(norm(path));
  }

  async readFile(path: string, opts?: { encoding?: string } | string): Promise<Uint8Array | string> {
    const node = this.get(path);
    if (!node) throw fsError("ENOENT", path);
    if (node.kind !== "file") throw fsError("EISDIR", path);
    const enc = typeof opts === "string" ? opts : opts && opts.encoding;
    return enc === "utf8" || enc === "utf-8" ? new TextDecoder().decode(node.data) : node.data;
  }

  async writeFile(
    path: string,
    data: Uint8Array | string,
    opts?: { mode?: number } | string,
  ): Promise<void> {
    const p = norm(path);
    const dir = this.nodes.get(parent(p));
    if (!dir) throw fsError("ENOENT", path);
    if (dir.kind !== "dir") throw fsError("ENOTDIR", path);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const mode = (typeof opts === "object" && opts && opts.mode) || 0o100644;
    const prev = this.nodes.get(p);
    this.nodes.set(p, {
      kind: "file",
      data: bytes,
      mode,
      mtimeMs: Date.now(),
      ino: prev ? prev.ino : this.nextIno++,
    });
  }

  async unlink(path: string): Promise<void> {
    const p = norm(path);
    const node = this.nodes.get(p);
    if (!node) throw fsError("ENOENT", path);
    if (node.kind === "dir") throw fsError("EISDIR", path);
    this.nodes.delete(p);
  }

  async readdir(path: string): Promise<string[]> {
    const p = norm(path);
    const node = this.nodes.get(p);
    if (!node) throw fsError("ENOENT", path);
    if (node.kind !== "dir") throw fsError("ENOTDIR", path);
    const prefix = p === "/" ? "/" : p + "/";
    const out: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key !== p && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
        out.push(key.slice(prefix.length));
      }
    }
    return out.sort();
  }

  async mkdir(path: string, opts?: { recursive?: boolean } | number): Promise<void> {
    const p = norm(path);
    if (this.nodes.has(p)) {
      if (typeof opts === "object" && opts && opts.recursive) return;
      throw fsError("EEXIST", path);
    }
    const up = parent(p);
    if (!this.nodes.has(up)) {
      if (typeof opts === "object" && opts && opts.recursive) await this.mkdir(up, opts);
      else throw fsError("ENOENT", path);
    }
    this.nodes.set(p, { kind: "dir", mode: 0o40755, mtimeMs: Date.now(), ino: this.nextIno++ });
  }

  async rmdir(path: string): Promise<void> {
    const p = norm(path);
    const node = this.nodes.get(p);
    if (!node) throw fsError("ENOENT", path);
    if (node.kind !== "dir") throw fsError("ENOTDIR", path);
    if ((await this.readdir(p)).length) throw fsError("ENOTEMPTY", path);
    this.nodes.delete(p);
  }

  async stat(path: string): Promise<Stats> {
    let node = this.get(path);
    let hops = 0;
    while (node && node.kind === "link" && hops++ < 8) node = this.get(node.target);
    if (!node) throw fsError("ENOENT", path);
    return new Stats(node);
  }

  async lstat(path: string): Promise<Stats> {
    const node = this.get(path);
    if (!node) throw fsError("ENOENT", path);
    return new Stats(node);
  }

  async readlink(path: string): Promise<string> {
    const node = this.get(path);
    if (!node) throw fsError("ENOENT", path);
    if (node.kind !== "link") throw fsError("EINVAL", path);
    return node.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    const p = norm(path);
    if (this.nodes.has(p)) throw fsError("EEXIST", path);
    this.nodes.set(p, { kind: "link", target, mode: 0o120000, mtimeMs: Date.now(), ino: this.nextIno++ });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const node = this.get(path);
    if (!node) throw fsError("ENOENT", path);
    node.mode = mode;
  }

  /** Files under `dir` (not .git), as repo-relative paths. */
  async listFiles(dir = "/"): Promise<string[]> {
    const root = norm(dir);
    const prefix = root === "/" ? "/" : root + "/";
    const out: string[] = [];
    for (const [key, node] of this.nodes) {
      if (node.kind !== "file" || !key.startsWith(prefix)) continue;
      const rel = key.slice(prefix.length);
      if (rel.startsWith(".git/")) continue;
      out.push(rel);
    }
    return out.sort();
  }
}
