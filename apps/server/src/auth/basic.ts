/**
 * Optional HTTP Basic auth in front of the whole server: UI, static files and
 * every /api route. Enabled by BULLPANE_BASIC_AUTH_USER + _PASSWORD.
 *
 * It is not a user system and does not touch the `users` feature: requests that
 * pass still become the free edition's anonymous admin in `authPlugin`. It exists
 * so an install can live on a public URL (a PaaS with no private ingress) without
 * being an open dashboard, and without a proxy container in front of it.
 *
 * Registered on the root instance before any plugin, so it runs first for every
 * route, the static files and the SPA fallback — nothing reaches a session lookup
 * or a Redis read without credentials.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface BasicAuthCredentials {
  user: string;
  password: string;
}

/**
 * Only the liveness probe, so the platform's healthcheck needs no secret. It
 * answers version + uptime and nothing else; /api/health/connections (Redis INFO)
 * stays behind the credentials.
 */
const EXEMPT_PATHS = new Set(["/api/health"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const CHALLENGE = 'Basic realm="Bullpane", charset="UTF-8"';

export function parseBasicAuth(header: string | undefined): BasicAuthCredentials | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header.trim());
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  // RFC 7617: the user-id cannot contain a colon, the password can.
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** Hashing first gives timingSafeEqual equal lengths, so length does not leak either. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function basicAuthHook(credentials: BasicAuthCredentials) {
  return async function basicAuth(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const pathOnly = request.url.split("?")[0] ?? request.url;
    if (EXEMPT_PATHS.has(pathOnly)) return undefined;

    const given = parseBasicAuth(request.headers.authorization);
    // Both compared every time, so a wrong user costs the same as a wrong password.
    const userOk = sameSecret(given?.user ?? "", credentials.user);
    const passwordOk = sameSecret(given?.password ?? "", credentials.password);
    if (!given || !userOk || !passwordOk) {
      return reply
        .status(401)
        .header("www-authenticate", CHALLENGE)
        .header("cache-control", "no-store")
        .send({ error: "unauthenticated", message: "Credentials required" });
    }

    /**
     * Browsers attach cached Basic credentials to cross-site requests too (a form
     * POST from any page), which the Pro login avoids with SameSite=Lax cookies.
     * Sec-Fetch-Site closes that gap for writes; clients that do not send it
     * (curl, scripts) are not browsers and are let through.
     */
    const site = request.headers["sec-fetch-site"];
    if (!SAFE_METHODS.has(request.method.toUpperCase()) && (site === "cross-site" || site === "same-site")) {
      return reply.status(403).send({ error: "forbidden", message: "Cross-site request refused" });
    }
    return undefined;
  };
}
