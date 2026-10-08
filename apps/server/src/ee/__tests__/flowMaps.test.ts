/**
 * Flow maps through the real Fastify app (`app.inject`) on a real SQLite file,
 * with fake inspectors standing in for Redis/Postgres so counts, missing queues,
 * down connections and FlowProducer samples can be set per connection.
 *
 * What is pinned down (docs/API.md "Flow maps"):
 *  - auth → Pro gate (402) → role (viewer reads, operator writes, 403 otherwise);
 *  - tree semantics: nesting, sibling positions, cycles refused (409), delete
 *    promotes children to the deleted map's parent;
 *  - edges: auto-add their ends, idempotent on the FULL (from, to) refs, 409 on
 *    a self loop, and they cross connections (Redis → Redis, Redis → Postgres);
 *  - a map read costs one getQueueStats per connection, for its queues only, and
 *    never fails on a missing queue or a down/deleted connection;
 *  - detected maps: computed from the sample, read-only (409), copyable;
 *  - deleting a connection removes only its side of every map.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnectionSchema, type Edition, EMPTY_COUNTS, type FlowMap, type FlowMapsResponse, type Role } from "@bullpane/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import { loadConfig } from "../../config";
import { createDatabase, type Database } from "../../db";
import { runMigrations } from "../../db/migrate";
import { isUnaudited } from "../plugins/audit";
import { detectedComponents } from "../services/flowMaps";

const PRO: Edition = {
  tier: "pro",
  demo: false,
  features: { alerts: true, users: true, folders: true, flows: true, audit: true, sso: true, mcp: true },
  license: null,
  pricing: { monthlyUsd: 39, yearlyUsd: 390 },
  checkoutUrl: "",
};
const FREE: Edition = { ...PRO, tier: "free", features: Object.fromEntries(Object.keys(PRO.features).map((k) => [k, false])) as Edition["features"] };

interface FakeRedis {
  queues: string[];
  /** child → parent samples, as sampleFlowEdges reports them */
  links: Array<{ child: string; parent: string; count: number }>;
  down: boolean;
}

function counts(waiting: number) {
  return { ...EMPTY_COUNTS, waiting };
}

function fakeInspector(r: FakeRedis) {
  const fail = () => {
    if (r.down) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  };
  return {
    ping: vi.fn(async () => (r.down ? { ok: false, latencyMs: 0, redisVersion: null, error: "down" } : { ok: true, latencyMs: 1, redisVersion: "7.2.0", error: null })),
    discoverQueues: vi.fn(async () => {
      fail();
      return r.queues;
    }),
    getQueueStats: vi.fn(async (names: string[]) => {
      fail();
      return Object.fromEntries(names.map((n) => [n, { counts: counts(n.length), isPaused: n.startsWith("paused") }]));
    }),
    sampleFlowEdges: vi.fn(async (queue: string) => {
      fail();
      const edges = r.links.filter((l) => l.child === queue).map((l) => ({ childQueue: l.child, parentQueue: l.parent, count: l.count }));
      return { edges, sampled: edges.length };
    }),
  };
}

const USERS: Record<string, Role> = { admin: "admin", op: "operator", viewer: "viewer" };

interface World {
  app: FastifyInstance;
  database: Database;
  dir: string;
  redis: Map<string, FakeRedis>;
  inspectors: Map<string, ReturnType<typeof fakeInspector>>;
  setEdition(e: Edition): void;
  /** creates a connection and its fake backend */
  connection(name: string, fake: Partial<FakeRedis>, kind?: "redis" | "postgres"): Promise<string>;
  call(method: string, url: string, opts?: { user?: string; body?: unknown }): Promise<LightMyRequestResponse>;
  ok<T>(method: string, url: string, body?: unknown): Promise<T>;
}

async function build(): Promise<World> {
  const dir = mkdtempSync(path.join(tmpdir(), "bullpane-flowmaps-"));
  const config = loadConfig({ SESSION_SECRET: "x".repeat(40), DEMO_MODE: "false", BULLPANE_DATA_DIR: dir, LOG_LEVEL: "silent" }, { warn: () => undefined });
  const database = createDatabase(config.database);
  await runMigrations(database, { info: () => undefined, warn: () => undefined });
  const redis = new Map<string, FakeRedis>();
  const inspectors = new Map<string, ReturnType<typeof fakeInspector>>();
  const pool = {
    get: (cfg: { id: string }) => {
      let i = inspectors.get(cfg.id);
      if (!i) {
        const r = redis.get(cfg.id) ?? { queues: [], links: [], down: true };
        redis.set(cfg.id, r);
        i = fakeInspector(r);
        inspectors.set(cfg.id, i);
      }
      return i;
    },
    evict: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  } as never;
  const app = await buildApp({ config, db: database.db, pool, logger: false, serveWeb: false });
  let edition = PRO;
  app.ctx.edition.getEdition = () => edition;
  app.addHook("onRequest", async (request) => {
    const id = request.headers["x-test-user"];
    if (typeof id === "string" && USERS[id]) {
      request.user = { id, email: `${id}@acme.com`, name: id, role: USERS[id], createdAt: new Date().toISOString(), lastLoginAt: null, disabledAt: null };
    }
  });
  await app.ready();

  const w: World = {
    app,
    database,
    dir,
    redis,
    inspectors,
    setEdition: (e) => (edition = e),
    async connection(name, fake, kind = "redis") {
      const input = createConnectionSchema.parse({
        name,
        kind,
        url: kind === "redis" ? "redis://127.0.0.1:1" : "postgres://app:x@127.0.0.1:1/app",
      });
      // create() pings through the pool first; the fake it made is then given this state.
      const pending: FakeRedis = { queues: [], links: [], down: false, ...fake };
      const created = await app.ctx.connections.create(input);
      redis.set(created.id, Object.assign(redis.get(created.id) ?? pending, pending));
      return created.id;
    },
    call: (method, url, opts = {}) =>
      app.inject({
        method: method as never,
        url: `/api${url}`,
        ...(opts.body !== undefined ? { payload: opts.body as never } : {}),
        headers: { "x-test-user": opts.user ?? "op" },
      }),
    async ok<T>(method: string, url: string, body?: unknown): Promise<T> {
      const res = await w.call(method, url, { body });
      if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
      return res.json() as T;
    },
  };
  return w;
}

let w: World;
beforeEach(async () => {
  w = await build();
});
afterEach(async () => {
  w.app.ctx.alertsEngine.stop();
  w.app.ctx.edition.stop();
  await w.app.close();
  await w.database.close();
  rmSync(w.dir, { recursive: true, force: true });
});

const node = (map: FlowMap, connectionId: string, queueName: string) => map.nodes.find((n) => n.connectionId === connectionId && n.queueName === queueName);

describe("flow maps: gates and roles", () => {
  it("is Pro: the free edition answers 402", async () => {
    w.setEdition(FREE);
    const res = await w.call("GET", "/flow-maps");
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: "pro_required", feature: "flows" });
    expect((await w.call("POST", "/flow-maps", { body: { name: "x" } })).statusCode).toBe(402);
  });

  it("asks for a login on Pro before anything else", async () => {
    const res = await w.app.inject({ method: "GET", url: "/api/flow-maps" });
    expect(res.statusCode).toBe(401);
  });

  it("a viewer reads but cannot write", async () => {
    const map = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Checkout" });
    expect((await w.call("GET", "/flow-maps", { user: "viewer" })).statusCode).toBe(200);
    expect((await w.call("GET", `/flow-maps/${map.id}`, { user: "viewer" })).statusCode).toBe(200);
    for (const [method, url, body] of [
      ["POST", "/flow-maps", { name: "x" }],
      ["PATCH", `/flow-maps/${map.id}`, { name: "y" }],
      ["DELETE", `/flow-maps/${map.id}`, undefined],
      ["POST", `/flow-maps/${map.id}/nodes`, { connectionId: "c", queueName: "q" }],
      ["PUT", `/flow-maps/${map.id}/layout`, { positions: [] }],
      ["POST", `/flow-maps/${map.id}/edges`, { from: { connectionId: "c", queueName: "a" }, to: { connectionId: "c", queueName: "b" } }],
      ["POST", `/flow-maps/${map.id}/copy`, {}],
    ] as const) {
      expect((await w.call(method, url, { user: "viewer", body })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("every write route is listed as deliberately not audited", () => {
    for (const route of [
      "POST /api/flow-maps",
      "PATCH /api/flow-maps/:id",
      "DELETE /api/flow-maps/:id",
      "POST /api/flow-maps/:id/nodes",
      "DELETE /api/flow-maps/:id/nodes/:nodeId",
      "PUT /api/flow-maps/:id/layout",
      "POST /api/flow-maps/:id/edges",
      "PATCH /api/flow-maps/:id/edges/:edgeId",
      "DELETE /api/flow-maps/:id/edges/:edgeId",
      "POST /api/flow-maps/:id/copy",
    ]) {
      const [method, pattern] = route.split(" ") as [string, string];
      expect(isUnaudited(method, pattern), route).toBe(true);
    }
  });
});

describe("flow maps: the tree", () => {
  it("nests maps, places new ones last among their siblings, and lists in tree order", async () => {
    const a = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Billing" });
    const b = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Checkout", description: "outbound" });
    const child1 = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Emails", parentId: b.id });
    const child2 = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Shipping", parentId: b.id });
    expect([a.position, b.position, child1.position, child2.position]).toEqual([0, 1, 0, 1]);
    expect(b).toMatchObject({ kind: "manual", description: "outbound", parentId: null, connectionId: null, nodes: [], edges: [] });

    const list = await w.ok<FlowMapsResponse>("GET", "/flow-maps");
    expect(list.maps.map((m) => m.name)).toEqual(["Billing", "Checkout", "Emails", "Shipping"]);
    expect(list.detectedComplete).toBe(true);

    expect((await w.call("POST", "/flow-maps", { body: { name: "x", parentId: "nope" } })).statusCode).toBe(404);
    expect((await w.call("GET", "/flow-maps/nope")).statusCode).toBe(404);
  });

  it("refuses to move a map under itself or a descendant (409), and moves it anywhere else", async () => {
    const top = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Top" });
    const mid = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Mid", parentId: top.id });
    const leaf = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Leaf", parentId: mid.id });
    expect((await w.call("PATCH", `/flow-maps/${top.id}`, { body: { parentId: leaf.id } })).statusCode).toBe(409);
    expect((await w.call("PATCH", `/flow-maps/${top.id}`, { body: { parentId: top.id } })).statusCode).toBe(409);
    expect((await w.call("PATCH", `/flow-maps/${top.id}`, { body: { parentId: "nope" } })).statusCode).toBe(404);

    const moved = await w.ok<FlowMap>("PATCH", `/flow-maps/${leaf.id}`, { parentId: null, name: "Leaf 2", position: 5 });
    expect(moved).toMatchObject({ parentId: null, name: "Leaf 2", position: 5 });
    const under = await w.ok<FlowMap>("PATCH", `/flow-maps/${top.id}`, { parentId: moved.id });
    expect(under.parentId).toBe(moved.id);
  });

  it("deleting a map moves its children to ITS parent and drops its drawing", async () => {
    const conn = await w.connection("events", { queues: ["a", "b"] });
    const top = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Top" });
    const mid = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Mid", parentId: top.id });
    const leaf1 = await w.ok<FlowMap>("POST", "/flow-maps", { name: "L1", parentId: mid.id });
    const leaf2 = await w.ok<FlowMap>("POST", "/flow-maps", { name: "L2", parentId: mid.id });
    await w.ok("POST", `/flow-maps/${mid.id}/edges`, { from: { connectionId: conn, queueName: "a" }, to: { connectionId: conn, queueName: "b" } });

    expect(await w.ok("DELETE", `/flow-maps/${mid.id}`)).toEqual({ ok: true });
    expect((await w.ok<FlowMap>("GET", `/flow-maps/${leaf1.id}`)).parentId).toBe(top.id);
    expect((await w.ok<FlowMap>("GET", `/flow-maps/${leaf2.id}`)).parentId).toBe(top.id);
    expect(await w.database.rows(`SELECT * FROM flow_map_nodes WHERE map_id = '${mid.id}'`)).toHaveLength(0);
    expect(await w.database.rows(`SELECT * FROM flow_map_edges WHERE map_id = '${mid.id}'`)).toHaveLength(0);
    expect((await w.call("DELETE", `/flow-maps/${mid.id}`)).statusCode).toBe(404);

    // A root map's children land at the root.
    await w.ok("DELETE", `/flow-maps/${top.id}`);
    expect((await w.ok<FlowMap>("GET", `/flow-maps/${leaf1.id}`)).parentId).toBeNull();
  });
});

describe("flow maps: queues and arrows", () => {
  it("an edge adds its missing ends, is idempotent on (from, to) and only updates the label", async () => {
    const conn = await w.connection("events", { queues: ["checkout", "payment-capture"] });
    const map = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Checkout" });
    const from = { connectionId: conn, queueName: "checkout" };
    const to = { connectionId: conn, queueName: "payment-capture" };

    const res = await w.call("POST", `/flow-maps/${map.id}/edges`, { body: { from, to, label: "per item" } });
    expect(res.statusCode).toBe(201);
    const drawn = res.json() as FlowMap;
    expect(drawn.nodes.map((n) => n.id).sort()).toEqual([`${conn}:checkout`, `${conn}:payment-capture`]);
    expect(drawn.edges).toEqual([expect.objectContaining({ from: `${conn}:checkout`, to: `${conn}:payment-capture`, source: "manual", label: "per item" })]);

    const again = await w.ok<FlowMap>("POST", `/flow-maps/${map.id}/edges`, { from, to, label: "each item" });
    expect(again.edges).toHaveLength(1);
    expect(again.edges[0]).toMatchObject({ id: drawn.edges[0]!.id, label: "each item" });
    // Without a label, drawing it again keeps the one it has.
    expect((await w.ok<FlowMap>("POST", `/flow-maps/${map.id}/edges`, { from, to })).edges[0]!.label).toBe("each item");

    expect((await w.call("POST", `/flow-maps/${map.id}/edges`, { body: { from, to: from } })).statusCode).toBe(409);
    expect((await w.call("POST", `/flow-maps/${map.id}/edges`, { body: { from, to: { connectionId: "nope", queueName: "x" } } })).statusCode).toBe(404);

    const edgeId = drawn.edges[0]!.id;
    expect((await w.ok<FlowMap>("PATCH", `/flow-maps/${map.id}/edges/${edgeId}`, { label: null })).edges[0]!.label).toBeNull();
    expect((await w.call("PATCH", `/flow-maps/${map.id}/edges/nope`, { body: { label: "x" } })).statusCode).toBe(404);
    const removed = await w.ok<FlowMap>("DELETE", `/flow-maps/${map.id}/edges/${edgeId}`);
    expect(removed.edges).toEqual([]);
    expect(removed.nodes).toHaveLength(2);
  });

  it("adding a queue is idempotent and updates its position when one is given; layout ignores unknown nodes", async () => {
    const conn = await w.connection("events", { queues: ["a", "b"] });
    const map = await w.ok<FlowMap>("POST", "/flow-maps", { name: "M" });
    await w.ok("POST", `/flow-maps/${map.id}/nodes`, { connectionId: conn, queueName: "a" });
    let got = await w.ok<FlowMap>("POST", `/flow-maps/${map.id}/nodes`, { connectionId: conn, queueName: "a" });
    expect(got.nodes).toHaveLength(1);
    expect(got.nodes[0]).toMatchObject({ x: null, y: null, missing: false, connectionName: "events" });
    got = await w.ok<FlowMap>("POST", `/flow-maps/${map.id}/nodes`, { connectionId: conn, queueName: "a", x: 10, y: 20 });
    expect(got.nodes[0]).toMatchObject({ x: 10, y: 20 });
    expect((await w.call("POST", `/flow-maps/${map.id}/nodes`, { body: { connectionId: "nope", queueName: "a" } })).statusCode).toBe(404);

    await w.ok("POST", `/flow-maps/${map.id}/nodes`, { connectionId: conn, queueName: "b" });
    expect(
      await w.ok("PUT", `/flow-maps/${map.id}/layout`, {
        positions: [
          { nodeId: `${conn}:a`, x: 1.5, y: -2 },
          { nodeId: `${conn}:ghost`, x: 9, y: 9 },
          { nodeId: "garbage", x: 9, y: 9 },
        ],
      }),
    ).toEqual({ ok: true });
    got = await w.ok<FlowMap>("GET", `/flow-maps/${map.id}`);
    expect(node(got, conn, "a")).toMatchObject({ x: 1.5, y: -2 });
    expect(node(got, conn, "b")).toMatchObject({ x: null, y: null });
    expect(got.nodes).toHaveLength(2);

    // Removing a queue removes the arrows touching it.
    await w.ok("POST", `/flow-maps/${map.id}/edges`, { from: { connectionId: conn, queueName: "a" }, to: { connectionId: conn, queueName: "b" } });
    got = await w.ok<FlowMap>("DELETE", `/flow-maps/${map.id}/nodes/${encodeURIComponent(`${conn}:a`)}`);
    expect(got.nodes.map((n) => n.queueName)).toEqual(["b"]);
    expect(got.edges).toEqual([]);
    expect((await w.call("DELETE", `/flow-maps/${map.id}/nodes/${encodeURIComponent(`${conn}:a`)}`)).statusCode).toBe(404);
  });

  it("writes bump updatedAt", async () => {
    const map = await w.ok<FlowMap>("POST", "/flow-maps", { name: "M" });
    const before = (await w.database.rows(`SELECT updated_at FROM flow_maps WHERE id = '${map.id}'`))[0]!.updated_at;
    await new Promise((r) => setTimeout(r, 15));
    await w.ok("PATCH", `/flow-maps/${map.id}`, { name: "N" });
    const after = (await w.database.rows(`SELECT updated_at FROM flow_maps WHERE id = '${map.id}'`))[0]!.updated_at;
    expect(after).not.toEqual(before);
  });
});

describe("flow maps: across connections", () => {
  it("draws an arrow from one connection to another (Redis → Redis and Redis → Postgres), with each side's own counts", async () => {
    const events = await w.connection("events", { queues: ["order-placed", "shared"] });
    const ai = await w.connection("ai", { queues: ["email-send", "shared"] });
    const pg = await w.connection("jobs-pg", { queues: ["archive"] }, "postgres");
    const map = await w.ok<FlowMap>("POST", "/flow-maps", { name: "Shipping" });

    const from = { connectionId: events, queueName: "order-placed" };
    const to = { connectionId: ai, queueName: "email-send" };
    let got = await w.ok<FlowMap>("POST", `/flow-maps/${map.id}/edges`, { from, to });
    expect(got.nodes).toHaveLength(2);
    expect(got.edges).toEqual([expect.objectContaining({ from: `${events}:order-placed`, to: `${ai}:email-send` })]);
    await w.ok("POST", `/flow-maps/${map.id}/edges`, { from: to, to: { connectionId: pg, queueName: "archive" } });

    // The same queue NAME on two connections is two nodes, and two arrows.
    await w.ok("POST", `/flow-maps/${map.id}/edges`, { from, to: { connectionId: events, queueName: "shared" } });
    await w.ok("POST", `/flow-maps/${map.id}/edges`, { from, to: { connectionId: ai, queueName: "shared" } });
    // ...and idempotency is per full ref: drawing the cross-connection one again adds nothing.
    got = await w.ok<FlowMap>("POST", `/flow-maps/${map.id}/edges`, { from, to, label: "reply" });
    expect(got.nodes.map((n) => n.id).sort()).toEqual(
      [`${events}:order-placed`, `${events}:shared`, `${ai}:email-send`, `${ai}:shared`, `${pg}:archive`].sort(),
    );
    expect(got.edges).toHaveLength(4);

    // A read: one getQueueStats per connection, for the queues on the map only.
    for (const i of w.inspectors.values()) i.getQueueStats.mockClear();
    got = await w.ok<FlowMap>("GET", `/flow-maps/${map.id}`);
    expect(w.inspectors.get(events)!.getQueueStats).toHaveBeenCalledTimes(1);
    expect(w.inspectors.get(ai)!.getQueueStats).toHaveBeenCalledTimes(1);
    expect(w.inspectors.get(pg)!.getQueueStats).toHaveBeenCalledTimes(1);
    expect(w.inspectors.get(events)!.getQueueStats.mock.calls[0]![0].sort()).toEqual(["order-placed", "shared"]);
    expect(w.inspectors.get(ai)!.getQueueStats.mock.calls[0]![0].sort()).toEqual(["email-send", "shared"]);
    expect(node(got, events, "order-placed")).toMatchObject({ connectionName: "events", counts: { waiting: "order-placed".length }, missing: false });
    expect(node(got, ai, "email-send")).toMatchObject({ connectionName: "ai", missing: false });
    expect(node(got, pg, "archive")).toMatchObject({ connectionName: "jobs-pg", missing: false });

    // Deleting one connection removes only its side: its nodes and the arrows touching them.
    expect((await w.call("DELETE", `/connections/${ai}`, { user: "admin" })).statusCode).toBe(200);
    got = await w.ok<FlowMap>("GET", `/flow-maps/${map.id}`);
    expect(got.nodes.map((n) => n.id).sort()).toEqual([`${events}:shared`, `${events}:order-placed`, `${pg}:archive`].sort());
    expect(got.edges).toEqual([expect.objectContaining({ from: `${events}:order-placed`, to: `${events}:shared` })]);
    expect(await w.database.rows(`SELECT * FROM flow_map_nodes WHERE connection_id = '${ai}'`)).toHaveLength(0);
    expect(
      await w.database.rows(`SELECT * FROM flow_map_edges WHERE from_connection_id = '${ai}' OR to_connection_id = '${ai}'`),
    ).toHaveLength(0);
  });

  it("a missing queue or a down connection is a missing node, never an error", async () => {
    const up = await w.connection("up", { queues: ["here"] });
    const down = await w.connection("down", { queues: ["there"] });
    const map = await w.ok<FlowMap>("POST", "/flow-maps", { name: "M" });
    await w.ok("POST", `/flow-maps/${map.id}/edges`, { from: { connectionId: up, queueName: "here" }, to: { connectionId: up, queueName: "not-yet" } });
    await w.ok("POST", `/flow-maps/${map.id}/nodes`, { connectionId: down, queueName: "there" });
    w.redis.get(down)!.down = true;

    const res = await w.call("GET", `/flow-maps/${map.id}`);
    expect(res.statusCode).toBe(200);
    const got = res.json() as FlowMap;
    expect(node(got, up, "here")).toMatchObject({ missing: false });
    expect(node(got, up, "not-yet")).toMatchObject({ missing: true, counts: EMPTY_COUNTS, isPaused: false });
    expect(node(got, down, "there")).toMatchObject({ missing: true, counts: EMPTY_COUNTS, connectionName: "down" });
    // the stats call only ever asks for discovered queues
    expect(w.inspectors.get(up)!.getQueueStats.mock.calls.at(-1)![0]).toEqual(["here"]);

    // The sample is cached 30 s; once it expires a down connection makes detection incomplete.
    w.app.ctx.flows.invalidate(down);
    const list = await w.ok<FlowMapsResponse>("GET", "/flow-maps");
    expect(list.detectedComplete).toBe(false);
  });
});

describe("flow maps: detected", () => {
  it("one map per FlowProducer group, rooted at the parent; read-only, copyable, and drawn on manual maps", async () => {
    const conn = await w.connection("events", {
      queues: ["parent", "child-a", "child-b", "solo", "x", "y"],
      links: [
        { child: "child-a", parent: "parent", count: 3 },
        { child: "child-b", parent: "parent", count: 2 },
        { child: "x", parent: "y", count: 1 },
      ],
    });
    const list = await w.ok<FlowMapsResponse>("GET", "/flow-maps");
    const detected = list.maps.filter((m) => m.kind === "detected");
    expect(detected.map((m) => m.id)).toEqual([`detected:${conn}:parent`, `detected:${conn}:y`]);
    expect(detected[0]).toMatchObject({ name: "parent", connectionId: conn, parentId: null, nodeCount: 3, edgeCount: 2 });

    const id = `detected:${conn}:parent`;
    const map = await w.ok<FlowMap>("GET", `/flow-maps/${encodeURIComponent(id)}`);
    expect(map.kind).toBe("detected");
    expect(map.nodes.map((n) => n.queueName).sort()).toEqual(["child-a", "child-b", "parent"]);
    expect(map.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `d:${conn}:parent->${conn}:child-a`, source: "detected", evidence: 3 }),
        expect.objectContaining({ from: `${conn}:parent`, to: `${conn}:child-b`, evidence: 2 }),
      ]),
    );
    expect((await w.call("GET", `/flow-maps/${encodeURIComponent(`detected:${conn}:child-a`)}`)).statusCode).toBe(404);
    expect((await w.call("GET", `/flow-maps/${encodeURIComponent("detected:nope:parent")}`)).statusCode).toBe(404);

    const enc = encodeURIComponent(id);
    for (const [method, url, body] of [
      ["PATCH", `/flow-maps/${enc}`, { name: "x" }],
      ["DELETE", `/flow-maps/${enc}`, undefined],
      ["POST", `/flow-maps/${enc}/nodes`, { connectionId: conn, queueName: "solo" }],
      ["DELETE", `/flow-maps/${enc}/nodes/${encodeURIComponent(`${conn}:parent`)}`, undefined],
      ["PUT", `/flow-maps/${enc}/layout`, { positions: [] }],
      ["POST", `/flow-maps/${enc}/edges`, { from: { connectionId: conn, queueName: "solo" }, to: { connectionId: conn, queueName: "parent" } }],
      ["PATCH", `/flow-maps/${enc}/edges/e`, { label: null }],
      ["DELETE", `/flow-maps/${enc}/edges/e`, undefined],
    ] as const) {
      const res = await w.call(method, url, { body });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().error).toBe("detected_map_read_only");
    }

    const copyRes = await w.call("POST", `/flow-maps/${enc}/copy`, { body: { name: "Parent flow" } });
    expect(copyRes.statusCode).toBe(201);
    const copy = copyRes.json() as FlowMap;
    expect(copy).toMatchObject({ kind: "manual", name: "Parent flow", parentId: null });
    expect(copy.nodes).toHaveLength(3);
    // The detected edges are drawn live on the copy, not stored as manual ones.
    expect(copy.edges.every((e) => e.source === "detected")).toBe(true);
    expect(copy.edges).toHaveLength(2);
    expect(await w.database.rows(`SELECT * FROM flow_map_edges WHERE map_id = '${copy.id}'`)).toHaveLength(0);

    // Copying a manual map takes its positions and drawn edges along.
    await w.ok("PUT", `/flow-maps/${copy.id}/layout`, { positions: [{ nodeId: `${conn}:parent`, x: 5, y: 6 }] });
    await w.ok("POST", `/flow-maps/${copy.id}/edges`, { from: { connectionId: conn, queueName: "parent" }, to: { connectionId: conn, queueName: "solo" }, label: "then" });
    const nested = await w.ok<FlowMap>("POST", `/flow-maps/${copy.id}/copy`, { parentId: copy.id });
    expect(nested).toMatchObject({ name: "Parent flow (copy)", parentId: copy.id });
    expect(node(nested, conn, "parent")).toMatchObject({ x: 5, y: 6 });
    expect(nested.edges.filter((e) => e.source === "manual")).toEqual([expect.objectContaining({ label: "then", to: `${conn}:solo` })]);
  });

  it("components: root is the queue no edge leaves, ties by incoming evidence then name", () => {
    const e = (from: string, to: string, evidence = 1) => ({ id: `${from}->${to}`, from, to, source: "detected" as const, evidence, label: null });
    const comps = detectedComponents([e("a", "root"), e("b", "root"), e("c", "a"), e("p", "q", 1), e("p", "r", 5), e("m", "n"), e("n", "m", 3)]);
    expect(comps.map((c) => [c.root, c.queues])).toEqual([
      ["m", ["m", "n"]],
      ["r", ["p", "q", "r"]],
      ["root", ["a", "b", "c", "root"]],
    ]);
  });
});
