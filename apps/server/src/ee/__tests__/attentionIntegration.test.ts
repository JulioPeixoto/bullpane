/**
 * Needs attention end to end, against a REAL redis-server with REAL BullMQ
 * Workers: official API writes the jobs and the metrics, the real
 * RedisInspector runs the real Lua, the real AlertsEngine judges. Only the
 * MySQL-backed services are in memory.
 *
 * This is the test that pins the product claims:
 *  - a queue with aggressive `removeOnComplete` is judged on what really
 *    happened (9%), not on what retention left behind (55% by ZCOUNT);
 *  - a job that fails an attempt and then succeeds is not a failure;
 *  - a Worker without `metrics` makes its queue "not measurable", never "healthy";
 *  - hidden queues are out of wide rules; the most specific rule wins;
 *  - processing time comes from the completed jobs, and is simply absent when
 *    retention keeps none.
 *
 * Port 6397 so it never collides with the inspector suite (6399) or a dev Redis.
 */
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, Worker, type Job } from "bullmq";
import { RedisInspector } from "@bullpane/redis-inspector";
import type { AlertCondition, AlertScope } from "@bullpane/shared";
import { AlertsEngine } from "../alerts/engine";
import type { AlertRow } from "../../db/schema";

const PORT = 6397;
const PREFIX = "att";
const connection = { host: "127.0.0.1", port: PORT };
const CONN = { id: "conn-1", name: "Test Redis", url: `redis://127.0.0.1:${PORT}`, prefix: PREFIX, cluster: false };

let inspector: RedisInspector;
const queues: Queue[] = [];

function redisCli(args: string): string {
  return execSync(`redis-cli -p ${PORT} ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

async function waitFor(pred: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

const METRICS = { maxDataPoints: 60 * 24 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `jobs` through a Worker until every one has finished, then closes it.
 * `fail(job)` decides whether an attempt throws.
 */
async function run(
  name: string,
  opts: {
    ok: number;
    bad?: number;
    metrics?: boolean;
    removeOnComplete?: boolean | { count: number };
    attempts?: number;
    workMs?: number;
    fail?: (job: Job) => boolean;
  },
): Promise<void> {
  const queue = new Queue(name, { connection, prefix: PREFIX });
  queues.push(queue);
  const attempts = opts.attempts ?? 1;
  const jobOpts = { attempts, removeOnComplete: opts.removeOnComplete ?? false };
  for (let i = 0; i < opts.ok; i++) await queue.add("ok", { i }, jobOpts);
  for (let i = 0; i < (opts.bad ?? 0); i++) await queue.add("bad", { i }, jobOpts);
  // Retention deletes finished jobs, so progress is counted from the Worker's
  // events: every completion, and only the FINAL failure of a job.
  let finished = 0;
  const worker = new Worker(
    name,
    async (job: Job) => {
      if (opts.workMs) await sleep(opts.workMs);
      if (job.name === "bad" || opts.fail?.(job)) throw new Error("boom");
      return 1;
    },
    { connection, prefix: PREFIX, concurrency: 5, ...(opts.metrics === false ? {} : { metrics: METRICS }) },
  );
  worker.on("completed", () => finished++);
  worker.on("failed", (job) => {
    if (job && job.attemptsMade >= attempts) finished++;
  });
  const total = opts.ok + (opts.bad ?? 0);
  await waitFor(async () => finished >= total);
  await worker.close();
}

beforeAll(async () => {
  try {
    redisCli("shutdown nosave");
  } catch {
    /* not running */
  }
  execSync(`redis-server --port ${PORT} --save "" --appendonly no --daemonize yes`, { stdio: "ignore" });
  await waitFor(async () => {
    try {
      return redisCli("ping") === "PONG";
    } catch {
      return false;
    }
  }, 10_000);
  inspector = new RedisInspector(CONN, { discoveryTtlMs: 0 });
}, 30_000);

afterAll(async () => {
  await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
  await inspector?.close();
  try {
    redisCli("shutdown nosave");
  } catch {
    /* already gone */
  }
});

// --- the fake MySQL side ---------------------------------------------------

function rule(id: string, scope: AlertScope, condition: AlertCondition): AlertRow {
  const cols =
    scope.type === "queue"
      ? { scopeType: "queue", connectionId: scope.connectionId, queueName: scope.queueName, folderId: null }
      : scope.type === "connection"
        ? { scopeType: "connection", connectionId: scope.connectionId, queueName: null, folderId: null }
        : { scopeType: "global", connectionId: null, queueName: null, folderId: null };
  return {
    id,
    name: id,
    enabled: true,
    ...cols,
    condition,
    channels: [],
    cooldownMinutes: 30,
    createdAt: new Date(),
    lastFiredAt: null,
    firing: false,
  } as AlertRow;
}

function engineWith(rows: AlertRow[], hidden: string[] = []) {
  const events: Array<{ status: string; queueName: string | null }> = [];
  const engine = new AlertsEngine({
    config: { alertsInterval: 15, publicUrl: "http://localhost:3000" } as never,
    alerts: {
      listRows: async () => rows,
      setState: async (id: string, s: { firing: boolean; lastFiredAt: Date | null }) => {
        Object.assign(rows.find((r) => r.id === id)!, s);
      },
      recordEvent: async (e: { status: string; queueName: string | null }) => void events.push(e),
      pruneEvents: async () => undefined,
    } as never,
    connections: {
      getRow: async () => CONN,
      listRows: async () => [CONN],
      hiddenQueueNames: async () => new Set(hidden),
      inspectorFor: () => inspector,
    } as never,
    folders: { get: async () => ({ id: "f", name: "F", queues: [] }) } as never,
    edition: { getEdition: () => ({ features: { alerts: true } }) } as never,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  });
  return { engine, events };
}

const rate = (percent: number): AlertCondition => ({ kind: "failed_rate_above", percent, windowMinutes: 15, minSample: 20 });
const slow = (seconds: number): AlertCondition => ({ kind: "duration_above", seconds, percentile: 95, windowMinutes: 15, minSample: 5 });

describe("Needs attention against real BullMQ", () => {
  beforeAll(async () => {
    await Promise.all([
      // 60 ok / 6 failed = 9.1% real; only 5 completed survive, so ZCOUNT says 6/11 = 55%
      run("pruned", { ok: 60, bad: 6, removeOnComplete: { count: 5 } }),
      // a Worker that keeps no metrics: failures exist, but cannot be measured honestly
      run("no-metrics", { ok: 10, bad: 10, metrics: false }),
      // 100% failure, but an admin hid this queue
      run("hidden-q", { ok: 0, bad: 25 }),
      // every job fails its first attempt and succeeds on the retry
      run("flaky-retries", { ok: 30, attempts: 2, fail: (job) => job.attemptsMade === 0 }),
      // slow, with enough completed jobs retained to time them
      run("slow", { ok: 12, workMs: 150, removeOnComplete: { count: 50 } }),
      // just as slow, but retention keeps nothing to time
      run("slow-pruned-all", { ok: 12, workMs: 150, removeOnComplete: true }),
    ]);
  }, 90_000);

  it("flags what really breaks the rules, and nothing else", async () => {
    const { engine } = engineWith([rule("global-5pct", { type: "global" }, rate(5)), rule("global-slow", { type: "global" }, slow(0.1))], ["hidden-q"]);
    await engine.tick();
    const snap = engine.attention();

    const flagged = snap.findings.map((f) => `${f.alertId}:${f.queueName}`).sort();
    expect(flagged).toEqual(["global-5pct:pruned", "global-slow:slow"]);

    const pruned = snap.findings.find((f) => f.queueName === "pruned")!;
    expect(pruned.value).toBeCloseTo((6 / 66) * 100, 1); // 9.09%, the truth
    expect(pruned).toMatchObject({ unit: "%", threshold: 5, windowMinutes: 15, notifies: false, scopeType: "global" });

    const slowQ = snap.findings.find((f) => f.queueName === "slow")!;
    expect(slowQ.value).toBeGreaterThanOrEqual(0.15);
    expect(slowQ.unit).toBe("s");

    // the Worker without metrics is named, not silently green
    expect(snap.unmeasured.map((u) => u.queueName)).toEqual(["no-metrics"]);
  });

  it("the zsets would have lied about the pruned queue (why metrics are the source)", async () => {
    const zset = await inspector.getWindowCounts("pruned", 0);
    expect(zset).toEqual({ completed: 5, failed: 6 });
    expect((zset.failed / (zset.completed + zset.failed)) * 100).toBeGreaterThan(50);
  });

  it("a failed attempt that succeeds on retry is not a failure", async () => {
    const w = (await inspector.getWindowMetrics([{ queue: "flaky-retries", rateWindows: [15], durationWindows: [] }]))["flaky-retries"]!;
    expect(w.rates[0]).toMatchObject({ completed: 30, failed: 0 });
  });

  it("a more specific rule replaces the global one for its queue", async () => {
    const { engine } = engineWith(
      [rule("global-5pct", { type: "global" }, rate(5)), rule("pruned-20pct", { type: "queue", connectionId: CONN.id, queueName: "pruned" }, rate(20))],
      ["hidden-q"],
    );
    await engine.tick();
    expect(engine.attention().findings.filter((f) => f.kind === "failed_rate_above")).toEqual([]);
  });

  it("a connection rule sees the hidden queue only when it is not hidden", async () => {
    const { engine } = engineWith([rule("conn-50pct", { type: "connection", connectionId: CONN.id }, rate(50))]);
    await engine.tick();
    expect(engine.attention().findings.map((f) => f.queueName)).toEqual(["hidden-q"]);
  });

  it("fires once per rule and records the event, even with no channel", async () => {
    const rows = [rule("global-5pct", { type: "global" }, rate(5))];
    const { engine, events } = engineWith(rows, ["hidden-q"]);
    await engine.tick();
    expect(rows[0]!.firing).toBe(true);
    expect(events.filter((e) => e.status === "fired")).toEqual([expect.objectContaining({ queueName: "pruned" })]);
    await engine.tick();
    expect(events.filter((e) => e.status === "fired")).toHaveLength(1); // cooldown, not a second notification
  });
});

/**
 * A known limit, pinned so it cannot become a surprise: BullMQ counts a
 * finished job in the metrics only when the Worker that finished it was
 * created with `metrics`. Two deployments of the same queue, one with and one
 * without, undercount — and nothing in Redis says so.
 */
describe("mixed deploy: only Workers with `metrics` are counted", () => {
  it("undercounts the jobs finished by the Worker without metrics", async () => {
    const name = "mixed";
    const queue = new Queue(name, { connection, prefix: PREFIX });
    queues.push(queue);
    for (let i = 0; i < 40; i++) await queue.add("ok", { i });
    let done = 0;
    const handler = async () => {
      await sleep(10);
      done++;
      return 1;
    };
    const withMetrics = new Worker(name, handler, { connection, prefix: PREFIX, concurrency: 2, metrics: METRICS });
    const without = new Worker(name, handler, { connection, prefix: PREFIX, concurrency: 2 });
    await waitFor(async () => done >= 40);
    await Promise.all([withMetrics.close(), without.close()]);

    const w = (await inspector.getWindowMetrics([{ queue: name, rateWindows: [15], durationWindows: [] }]))[name]!;
    expect(w.hasMetrics).toBe(true);
    expect(w.rates[0]!.completed).toBeGreaterThan(0);
    expect(w.rates[0]!.completed).toBeLessThan(40);
  }, 30_000);
});
