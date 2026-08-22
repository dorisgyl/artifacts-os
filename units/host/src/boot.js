// The container boot script.
//
// Everything here is shaped by things M0 measured. The order of the first two
// lines is not cosmetic: a failed `exec` redirection terminates a POSIX shell
// outright, so /state must exist before the log is redirected into it, and a
// mistake here surfaces to the host as an opaque Worker 1101 with no mention of
// the container at all.
//
// The brain's two ends are files, never in-memory handles (ADR-07). The holder
// process keeps one write end of the FIFO open forever: without it the first
// open-write-close by the host would drop the writer count to zero, the brain
// would read EOF on stdin and exit.

export const CODEX_VERSION = "rust-v0.149.0";
// Two assets, not the 104 MB `-package-` bundle: that is exactly these two and
// downloading it as one blob stalled repeatedly, leaving the task wedged in
// booting with no error. Separately they retry independently.
//
// The code-mode host is not optional. app-server shells out to it for anything
// that touches the machine, and without it the agent starts, reasons, answers,
// and then loops forever on "the workspace command runner failed to start" --
// which reads like a container fault and is not one.
const ASSET = (name) =>
  "https://github.com/openai/codex/releases/download/" + CODEX_VERSION +
  "/" + name + "-x86_64-unknown-linux-musl.tar.gz";

const NL = String.fromCharCode(10);

/**
 * @param {{configToml: string, repo: string|null, branch: string|null}} spec
 */
export function bootScript(spec) {
  const cfg = btoa(spec.configToml || "# none");
  const lines = [
    "mkdir -p /state /opt/codex /state/codex-home /workspace",
    "exec >> /state/boot.log 2>&1",
    // The config carries credentials, so it is written before tracing is on.
    // With `set -x` the base64 lands in the boot log, and the boot log is
    // served by /diagnostics -- which would walk the token out of the
    // container over HTTP, a boundary ADR-04 never agreed to cross.
    "echo " + cfg + " | base64 -d > /state/codex-home/config.toml",
    "set -x",

    "apk add --no-cache curl tar git ca-certificates ripgrep || true",

    // A stalled download must fail the task, not wedge it in booting forever.
    "fetch() { curl -fsSL --retry 3 --retry-delay 2 --max-time 240 " +
      "--speed-limit 51200 --speed-time 30 -o \"$1\" \"$2\"; }",
    "fetch /tmp/as.tar.gz '" + ASSET("codex-app-server") + "' || " +
      "{ echo 'FATAL app-server download failed' > /state/fatal; exit 1; }",
    "fetch /tmp/cm.tar.gz '" + ASSET("codex-code-mode-host") + "' || " +
      "{ echo 'FATAL code-mode-host download failed' > /state/fatal; exit 1; }",
    "tar -xzf /tmp/as.tar.gz -C /opt/codex",
    "tar -xzf /tmp/cm.tar.gz -C /opt/codex",
    // The release tarballs carry the platform triple in the file name, but
    // app-server looks for its siblings by bare name next to itself:
    // "failed to spawn code-mode host /opt/codex/codex-code-mode-host".
    // Strip the suffix for everything extracted, so any sibling added later
    // lands where it will be looked for.
    "for f in /opt/codex/*-x86_64-unknown-linux-musl; do " +
      "[ -e \"$f\" ] && ln -sf \"$f\" \"${f%-x86_64-unknown-linux-musl}\"; done",
    // By name, not "first executable found": the package holds several.
    "BIN=/opt/codex/codex-app-server",
    "test -x \"$BIN\" || BIN=$(find /opt/codex -type f -name 'codex-app-server*' -perm -u+x | head -n1)",
    "echo \"$BIN\" > /state/bin.txt",
    "ls -l $(dirname \"$BIN\")",
    // The siblings are found next to the binary, but PATH makes it explicit.
    "export PATH=$(dirname \"$BIN\"):$PATH",
    "test -n \"$BIN\" || { echo 'FATAL no codex binary' > /state/fatal; exit 1; }",
  ];

  if (spec.repo) {
    // Shallow: the agent needs the working tree, not the history, and a deep
    // clone is pure boot latency on every task.
    const branch = spec.branch ? " --branch '" + spec.branch + "'" : "";
    lines.push(
      "git clone --depth 1" + branch + " '" + spec.repo + "' /workspace 2>&1 || " +
        "{ echo 'FATAL clone failed' > /state/fatal; exit 1; }",
      "git -C /workspace rev-parse HEAD > /state/head.txt",
    );
  }

  lines.push(
    // The host gets a window between "everything is in place" and "the brain is
    // running". Restoring a rollout has to land before app-server starts or it
    // will not see the thread; the same window is where anything else the
    // container must not carry in its image or its argv gets injected.
    "date +%s > /state/ready",
    "while [ ! -f /state/go ]; do sleep 1; done",
    "mkfifo /state/in.fifo",
    "(while true; do sleep 3600; done) > /state/in.fifo &",
    "cd /workspace",
    "PATH=$(dirname \"$BIN\"):$PATH CODEX_HOME=/state/codex-home \"$BIN\" < /state/in.fifo >> /state/out.jsonl 2>> /state/err.log &",
    "echo $! > /state/brain.pid",
    "date +%s > /state/up.txt",
    // pid 1 must outlive everything above
    "while true; do sleep 3600; done",
  );
  return lines.join(NL);
}

/**
 * `envKey` names the environment variable holding the provider key. Leave it
 * null when something in front of the provider holds the key instead.
 *
 * `model_providers` is how the deployer points Codex somewhere other than
 * OpenAI's own endpoint. `wire_api` has only one legal value now -- Codex
 * removed the `chat` wire API, so an arbitrary "OpenAI-compatible" endpoint
 * will not work; it has to speak Responses.
 *
 * A custom provider also changes the transport: with one configured the model
 * traffic is ordinary HTTPS, while the built-in `openai` provider opens a
 * WebSocket to wss://api.openai.com/v1/responses.
 */
export function configToml({ baseUrl, model, extraHeaders, envKey }) {
  // TOML tables run until the next header, so every top-level key has to be
  // emitted before the first one. Getting this wrong does not produce a partial
  // config: Codex reports `invalid type ... expected a boolean` and falls back
  // to defaults wholesale, so the provider, the gateway header and the feature
  // flag all vanish together and the failure surfaces somewhere else entirely.
  const top = [
    "# generated by codex-cloud; edits here are overwritten on every task",
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
  ];
  if (model) top.push('model = "' + model + '"');
  if (baseUrl) top.push('model_provider = "cloud"');

  const tables = [
    "",
    "[features]",
    // Named by the warning app-server emits when the binary is absent. The flag
    // and the binary are both required; either one alone leaves the agent able
    // to think and answer but unable to touch the machine.
    "code_mode_host = true",
  ];

  if (baseUrl) {
    tables.push(
      "",
      "[model_providers.cloud]",
      'name = "codex-cloud outbound"',
      'base_url = "' + baseUrl + '"',
      'wire_api = "responses"',
    );
    // `env_key` is optional, and omitting it is the point when the provider key
    // is stored at a gateway: Codex then sends no Authorization header of its
    // own and the gateway supplies one. Naming a variable that does not exist
    // makes Codex refuse before it ever opens a connection --
    // "Missing environment variable: `OPENAI_API_KEY`" with willRetry false.
    if (envKey) tables.push('env_key = "' + envKey + '"');

    const headers = Object.entries(extraHeaders || {});
    if (headers.length) {
      tables.push("", "[model_providers.cloud.http_headers]");
      for (const [k, v] of headers) tables.push(k + ' = "' + v + '"');
    }
  }
  return top.concat(tables).join(NL);
}
