// The bindings this Worker runs with. Kept by hand rather than generated so it
// reads as documentation; `npx wrangler types` will produce the same shape.

import type { RepoCoordinator } from "./control/coordinator.ts";
import type { UserIndex } from "./control/user-index.js";
import type { AgentRunParams } from "./agents/agent-run.ts";
import type { NewAppParams } from "./agents/new-app.ts";
import type { FanOutParams } from "./agents/fan-out.ts";

export interface Env {
  ARTIFACTS: Artifacts;
  LOADER: WorkerLoader;
  AI: Ai;
  ASSETS: Fetcher;

  COORD: DurableObjectNamespace<RepoCoordinator>;
  INDEX: DurableObjectNamespace<UserIndex>;
  TASK: DurableObjectNamespace;

  AGENT_RUN: Workflow<AgentRunParams>;
  REVIEW: Workflow<unknown>;
  NEW_APP: Workflow<NewAppParams>;
  FAN_OUT: Workflow<FanOutParams>;

  ARTIFACTS_NAMESPACE: string;
  MODEL?: string;
  FALLBACK_MODEL?: string;
  AI_GATEWAY_NAME?: string;

  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_TOKEN?: string;
  OPENAI_API_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  DEV_IDENTITY?: string;
  TENANT?: string;
}

// The personal runtime has one owner, so one registry. The container host
// reports to `tenant/<t>/user/<u>`; this is the name it is given.
export const OWNER = { tenant: "default", user: "owner" } as const;
export const REGISTRY_NAME = "tenant/" + OWNER.tenant + "/user/" + OWNER.user;

export function registry(env: Env) {
  return env.INDEX.get(env.INDEX.idFromName(REGISTRY_NAME));
}

export function coordinator(env: Env, repo: string) {
  return env.COORD.get(env.COORD.idFromName(repo));
}
