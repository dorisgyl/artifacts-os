// A real Smart HTTP git server for tests: `git http-backend` behind node:http.
// It stands in for Artifacts' git endpoint so the git layer is exercised over
// the same protocol it uses in production, push included.

import { createServer, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitServer {
  root: string;
  url: (repo: string) => string;
  create: (repo: string) => void;
  close: () => Promise<void>;
}

export async function startGitServer(): Promise<GitServer> {
  const root = mkdtempSync(join(tmpdir(), "aos-git-"));
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url || "/", "http://localhost");
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: u.pathname.replace(/^\/git/, ""),
      QUERY_STRING: u.search.slice(1),
      REQUEST_METHOD: req.method || "GET",
      CONTENT_TYPE: String(req.headers["content-type"] || ""),
      REMOTE_USER: "test",
      REMOTE_ADDR: "127.0.0.1",
      GIT_PROTOCOL: String(req.headers["git-protocol"] || ""),
      HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] || ""),
    };
    const cgi = spawn("git", ["http-backend"], { env });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf("\r\n\r\n");
      if (idx < 0) return;
      headersDone = true;
      const lines = head.subarray(0, idx).toString().split("\r\n");
      let status = 200;
      for (const line of lines) {
        const [k, ...v] = line.split(":");
        const val = v.join(":").trim();
        if (k.toLowerCase() === "status") status = parseInt(val, 10);
        else res.setHeader(k, val);
      }
      res.statusCode = status;
      res.write(head.subarray(idx + 4));
    });
    cgi.stdout.on("end", () => res.end());
    cgi.stderr.on("data", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    root,
    url: (repo) => "http://127.0.0.1:" + port + "/git/" + repo + ".git",
    create: (repo) => {
      const dir = join(root, repo + ".git");
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "--bare", "-q", "-b", "main", dir]);
      execFileSync("git", ["-C", dir, "config", "http.receivepack", "true"]);
      execFileSync("git", ["-C", dir, "config", "uploadpack.allowAnySHA1InWant", "true"]);
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
