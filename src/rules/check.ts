// The rules review: every push, from any agent, is checked against the
// owner's rules repository before anyone is asked to look at it.
//
// These checks are static and cheap on purpose. They are the first layer; the
// second is the runtime itself, which loads apps with no network at all, so a
// change that slips past `no-network` still cannot send anything anywhere.

export interface RuleDef {
  id: string;
  check: "no-network" | "agent-paths" | "no-full-card-numbers" | "no-dependencies" | string;
  description: string;
}

export interface RulesFile {
  version: number;
  rules: RuleDef[];
}

export interface AppManifest {
  name?: string;
  templatePaths?: string[];
  agentPaths?: string[];
  gates?: { beforeMerge?: string[] };
}

export interface ChangedContent {
  path: string;
  type: "add" | "modify" | "delete";
  content: string | null;
}

export interface Finding {
  rule: string;
  path?: string;
  line?: number;
  detail: string;
}

export interface ReviewResult {
  verdict: "pass" | "reject";
  findings: Finding[];
  checked: string[];
}

/** Glob with `*` (one segment) and `**` (any depth). */
export function globMatch(glob: string, path: string): boolean {
  const re = glob
    .split("**")
    .map((part) => part.split("*").map(escapeRe).join("[^/]*"))
    .join(".*");
  return new RegExp("^" + re + "$").test(path);
}

function escapeRe(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Which kind of change a branch carries, from its name. */
export function branchRole(repo: string, branch: string): "agent" | "template-fix" | "upgrade" | "owner" {
  if (repo.startsWith("tpl-") && branch.startsWith("fix/")) return "template-fix";
  if (branch.startsWith("upgrade/")) return "upgrade";
  if (/^(agent|attempt|ext|change)\//.test(branch)) return "agent";
  return "owner";
}

const NETWORK = [
  { re: /\bfetch\s*\(/, what: "fetch()" },
  { re: /\bconnect\s*\(/, what: "connect()" },
  { re: /new\s+WebSocket\s*\(/, what: "WebSocket" },
  { re: /XMLHttpRequest/, what: "XMLHttpRequest" },
  { re: /\bhttps?:\/\/[^\s'"`)]+/, what: "a URL" },
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function findCardNumbers(text: string): { line: number; last4: string }[] {
  const out: { line: number; last4: string }[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) out.push({ line: i + 1, last4: digits.slice(-4) });
    }
  });
  return out;
}

const IMPORT = /(?:^|\n)\s*(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;

export function review(input: {
  repo: string;
  branch: string;
  rules: RulesFile;
  app: AppManifest | null;
  changed: ChangedContent[];
}): ReviewResult {
  const findings: Finding[] = [];
  const checked: string[] = [];
  const role = branchRole(input.repo, input.branch);
  const isCode = (p: string) => /\.(m?js|ts)$/.test(p);

  for (const rule of input.rules.rules) {
    checked.push(rule.id);
    switch (rule.check) {
      case "agent-paths": {
        if (role !== "agent" || !input.app) break;
        const allowed = input.app.agentPaths || [];
        for (const c of input.changed) {
          if (!allowed.some((g) => globMatch(g, c.path))) {
            const template = (input.app.templatePaths || []).some((g) => globMatch(g, c.path));
            findings.push({
              rule: rule.id,
              path: c.path,
              detail: template
                ? "template code: change it in the template repository so every app gets the fix"
                : "not in agentPaths",
            });
          }
        }
        break;
      }
      case "no-network": {
        for (const c of input.changed) {
          if (!c.content || !isCode(c.path)) continue;
          c.content.split("\n").forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return; // comments may cite URLs
            for (const n of NETWORK) {
              if (n.re.test(line)) {
                findings.push({ rule: rule.id, path: c.path, line: i + 1, detail: "network call: " + n.what });
                break;
              }
            }
          });
        }
        break;
      }
      case "no-full-card-numbers": {
        for (const c of input.changed) {
          if (!c.content) continue;
          for (const hit of findCardNumbers(c.content)) {
            findings.push({ rule: rule.id, path: c.path, line: hit.line, detail: "full card number ending " + hit.last4 });
          }
        }
        break;
      }
      case "no-dependencies": {
        for (const c of input.changed) {
          if (!c.content) continue;
          if (c.path.endsWith("package.json")) {
            try {
              const pkg = JSON.parse(c.content);
              for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
                if (pkg[k] && Object.keys(pkg[k]).length) {
                  findings.push({ rule: rule.id, path: c.path, detail: k + " declared" });
                }
              }
            } catch {
              findings.push({ rule: rule.id, path: c.path, detail: "package.json does not parse" });
            }
          }
          if (!isCode(c.path)) continue;
          for (const m of c.content.matchAll(IMPORT)) {
            const spec = m[1];
            const ok = spec.startsWith("./") || spec.startsWith("../") || spec === "cloudflare:workers" ||
              (spec.startsWith("node:") && c.path.startsWith("tests/"));
            if (!ok) findings.push({ rule: rule.id, path: c.path, detail: "import of '" + spec + "'" });
          }
        }
        break;
      }
      default:
        // An unknown check is reported, not silently passed: a rule the
        // runtime cannot enforce must be visible to the owner.
        findings.push({ rule: rule.id, detail: "unknown check '" + rule.check + "' is not enforced" });
    }
  }

  const blocking = findings.filter((f) => !f.detail.startsWith("unknown check"));
  return { verdict: blocking.length ? "reject" : "pass", findings, checked };
}
