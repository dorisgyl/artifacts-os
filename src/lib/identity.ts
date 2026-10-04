// Who is asking. Cloudflare Access sits in front of the whole runtime --
// Console, APIs, apps and MCP alike -- so by the time a request is here it has
// been authenticated; this only reads the result.
//
// Preferred: `ctx.access`, present when Access protects this Worker (one click
// in the dashboard, workers.dev and preview URLs included). Fallback: verify
// the Access JWT ourselves (codex-cloud's access.js), for a custom-domain
// Access application. Last: DEV_IDENTITY for `wrangler dev` only.

import type { Env } from "../env.ts";
import { identify as verifyAccessJwt } from "./access.js";

export type Identity = { tenant: string; user: string; kind: "human" | "service" | "dev" };
export type IdentityError = { error: string; detail?: string };

export async function identify(request: Request, env: Env, ctx: ExecutionContext): Promise<Identity | IdentityError> {
  const tenant = env.TENANT || "default";
  let id: Identity | IdentityError;

  if (ctx.access) {
    const who = await ctx.access.getIdentity().catch(() => undefined);
    // Access let the request through; no user identity means a service token
    // (Claude Code's MCP connection, for one).
    id = who && who.email ? { tenant, user: who.email, kind: "human" } : { tenant, user: "svc:access", kind: "service" };
  } else {
    id = (await verifyAccessJwt(request, env)) as Identity | IdentityError;
  }
  if ("error" in id) return id;

  // A personal runtime has one owner. Service tokens are scoped by Access
  // policy, so only human identities are compared.
  if (env.OWNER_EMAIL && id.kind === "human" && id.user.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    return { error: "not-the-owner", detail: id.user };
  }
  return id;
}
