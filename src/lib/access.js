// Cloudflare Access identity.
//
// Access authenticates before the request reaches this Worker and hands the
// result over as a signed assertion. Verifying it is the whole of authentication
// here: there is no account system of our own, and the deployer is not asked to
// have one (ADR-01).
//
// Everything downstream derives object names from what this returns, so a
// mistake here is not "the wrong error page", it is one user reaching another
// user's tasks. When anything is unverifiable this refuses.

const CERT_TTL_MS = 60 * 60 * 1000;
let certCache = { host: null, at: 0, keys: null };

function teamHost(raw) {
  const t = String(raw).trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return t.includes(".") ? t : t + ".cloudflareaccess.com";
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function jwks(host) {
  const fresh = certCache.host === host && Date.now() - certCache.at < CERT_TTL_MS;
  if (fresh && certCache.keys) return certCache.keys;
  const res = await fetch("https://" + host + "/cdn-cgi/access/certs");
  if (!res.ok) throw new Error("access certs unavailable: " + res.status);
  const body = await res.json();
  certCache = { host, at: Date.now(), keys: body.keys || [] };
  return certCache.keys;
}

async function verify(token, host, aud) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed assertion");
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawHeader)));
  if (header.alg !== "RS256") throw new Error("unexpected alg " + header.alg);

  const keys = await jwks(host);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown kid");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(rawSignature),
    new TextEncoder().encode(rawHeader + "." + rawPayload),
  );
  if (!ok) throw new Error("bad signature");

  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawPayload)));
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new Error("expired");
  if (claims.nbf && claims.nbf > now + 60) throw new Error("not yet valid");
  if (claims.iss !== "https://" + host) throw new Error("wrong issuer");

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) throw new Error("wrong audience");

  return claims;
}

/**
 * Returns `{ tenant, user, kind }` or `{ error }`.
 *
 * Human logins and service tokens are both first-class and get separate shards:
 * a service token has no email, and treating its common_name as one would put
 * CI and a person on the same object.
 */
export async function identify(request, env) {
  const configured = env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD;
  const tenant = env.TENANT || "default";

  if (configured) {
    const token =
      request.headers.get("Cf-Access-Jwt-Assertion") ||
      (request.headers.get("Cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
    if (!token) return { error: "access-assertion-missing" };
    try {
      const claims = await verify(token, teamHost(env.ACCESS_TEAM_DOMAIN), env.ACCESS_AUD);
      if (claims.common_name) {
        return { tenant, user: "svc:" + claims.common_name, kind: "service" };
      }
      const user = claims.email || claims.sub;
      if (!user) return { error: "access-assertion-has-no-subject" };
      return { tenant, user, kind: "human" };
    } catch (e) {
      return { error: "access-assertion-rejected", detail: String(e.message || e) };
    }
  }

  // DEV_IDENTITY exists because Access sits in front of a deployment, not in
  // front of `wrangler dev`. It is read only when Access is unconfigured, so a
  // deployed instance cannot fall into it by forgetting a flag.
  if (env.DEV_IDENTITY) {
    return { tenant, user: String(env.DEV_IDENTITY), kind: "dev" };
  }

  // Refusing is the only honest answer. A deployment with no identity in front
  // of it would otherwise serve an agent with a shell to anyone who finds it.
  return { error: "access-not-configured" };
}
