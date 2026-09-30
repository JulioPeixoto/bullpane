/**
 * BULLPANE_BASIC_AUTH_*: the hook sits on the root instance, so it must cover
 * routes registered later in child plugins and the SPA fallback, leave only the
 * liveness probe open, and refuse cross-site writes that ride on cached
 * credentials.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { basicAuthHook, parseBasicAuth } from "../auth/basic";

const USER = "ops";
const PASSWORD = "correct:horse-battery-staple";

function header(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

const GOOD = header(USER, PASSWORD);

let app: FastifyInstance;

async function harness(): Promise<FastifyInstance> {
  app = Fastify();
  app.addHook("onRequest", basicAuthHook({ user: USER, password: PASSWORD }));
  await app.register(
    async (api) => {
      api.get("/health", async () => ({ ok: true }));
      api.get("/health/connections", async () => []);
      api.get("/connections", async () => []);
      api.post("/connections/c/queues/q/pause", async () => ({ ok: true }));
    },
    { prefix: "/api" },
  );
  app.setNotFoundHandler(async (_request, reply) => reply.status(200).send("<!doctype html>"));
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
});

describe("basic auth hook", () => {
  it("challenges a request without credentials", async () => {
    await harness();
    const res = await app.inject({ method: "GET", url: "/api/connections" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="Bullpane", charset="UTF-8"');
    expect(res.json()).toEqual({ error: "unauthenticated", message: "Credentials required" });
  });

  it("refuses a wrong user or a wrong password", async () => {
    await harness();
    for (const authorization of [header("other", PASSWORD), header(USER, "nope"), "Bearer abc", "Basic !!!"]) {
      const res = await app.inject({ method: "GET", url: "/api/connections", headers: { authorization } });
      expect(res.statusCode, authorization).toBe(401);
    }
  });

  it("lets the right credentials through, with a colon in the password", async () => {
    await harness();
    const res = await app.inject({ method: "GET", url: "/api/connections", headers: { authorization: GOOD } });
    expect(res.statusCode).toBe(200);
  });

  it("protects the UI too, not only /api", async () => {
    await harness();
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/queues/x" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/", headers: { authorization: GOOD } })).statusCode).toBe(200);
  });

  it("leaves only the liveness probe open", async () => {
    await harness();
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health?probe=1" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health/connections" })).statusCode).toBe(401);
  });

  it("refuses a cross-site write even with valid credentials", async () => {
    await harness();
    const url = "/api/connections/c/queues/q/pause";
    for (const site of ["cross-site", "same-site"]) {
      const res = await app.inject({ method: "POST", url, headers: { authorization: GOOD, "sec-fetch-site": site } });
      expect(res.statusCode, site).toBe(403);
    }
    for (const site of ["same-origin", "none", undefined]) {
      const headers: Record<string, string> = { authorization: GOOD };
      if (site) headers["sec-fetch-site"] = site;
      expect((await app.inject({ method: "POST", url, headers })).statusCode, String(site)).toBe(200);
    }
  });

  it("does not block cross-site reads (following a link to the dashboard)", async () => {
    await harness();
    const res = await app.inject({
      method: "GET",
      url: "/api/connections",
      headers: { authorization: GOOD, "sec-fetch-site": "cross-site" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("parseBasicAuth", () => {
  it("splits on the first colon only", () => {
    expect(parseBasicAuth(header("a", "b:c"))).toEqual({ user: "a", password: "b:c" });
  });

  it("returns null for anything that is not Basic user:password", () => {
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth("")).toBeNull();
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    expect(parseBasicAuth(`Basic ${Buffer.from("no-colon").toString("base64")}`)).toBeNull();
  });
});
