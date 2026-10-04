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
    if (who && who.email) {
      id = { tenant, user: who.email, kind: "human" };
    } else {
      // No user identity: only a service token (Claude Code's MCP connection,
      // for one) is acceptable, and it must say so in the assertion Access
      // attached. Anything else fails closed.
      const cn = serviceTokenName(request);
      id = cn ? { tenant, user: "svc:" + cn, kind: "service" } : { error: "access-identity-unavailable" };
    }
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

/**
 * The service token's common_name from the Access assertion. Read only when
 * ctx.access is present -- that is, when Access itself fronted this request
 * and validated the assertion before the Worker saw it.
 */
function serviceTokenName(request: Request): string | null {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part + "===".slice((part.length + 3) % 4))) as { common_name?: string };
    return claims.common_name ? String(claims.common_name) : null;
  } catch {
    return null;
  }
}
