/**
 * The alerts engine — and therefore Needs attention in Pro — driven with a fake
 * inspector. What is pinned down here:
 *
 *  - error rules are measured from BullMQ's per-minute metrics (getWindowMetrics)
 *    and NEVER from the completed/failed sorted sets, so a queue using
 *    `removeOnComplete` no longer reads as a queue that fails constantly;
 *  - a queue without metrics makes the rule inert, visibly, with ONE
 *    informative event and no notification;
 *  - the window is exact from the first tick: no warm-up after a restart;
 *  - wide scopes (connection, global) skip hidden queues, and the most specific
 *    rule wins per condition kind;
 *  - a rule with no channels flags and records, but notifies nobody;
 *  - the attention snapshot lists exactly the (rule, queue) pairs that breach;
 *  - pausing a queue does not fire a backlog rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert, AlertCondition, AlertScope } from "@bullpane/shared";
import type { WindowMetricsRequest } from "@bullpane/redis-inspector";
import { AlertsEngine, applyOverrides, summarise } from "../alerts/engine";
import type { Sample } from "../alerts/evaluate";
import type { AlertRow } from "../../db/schema";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

// --- fakes -----------------------------------------------------------------

interface FakeQueue {
  /** finished inside any window; null = the queue collects no metrics */
  window: { completed: number; failed: number } | null;
  /** processing time sample in the window */
  duration?: { sampled: number; p50Ms: number; p95Ms: number };
  counts?: { waiting: number; paused: number; prioritized: number };
}

const CONNECTIONS = [
  { id: "conn-1", name: "Prod" },
  { id: "conn-2", name: "Staging" },
];

function fakeWorld() {
  const redis = new Map<string, Map<string, FakeQueue>>(CONNECTIONS.map((c) => [c.id, new Map()]));
  const hidden = new Map<string, Set<string>>();
  let failingConnection: string | null = null;

  function inspectorFor(row: { id: string }) {
    const queues = redis.get(row.id) ?? new Map<string, FakeQueue>();
    return {
      config: { id: row.id, url: "redis://x", prefix: "bull", cluster: false },
      discoverQueues: vi.fn(async () => [...queues.keys()]),
      getQueueStats: vi.fn(async (names: string[]) => {
        const out: Record<string, unknown> = {};
        for (const n of names) {
          const q = queues.get(n);
          if (!q) continue;
          const c = q.counts ?? { waiting: 0, paused: 0, prioritized: 0 };
          out[n] = { counts: { waiting: c.waiting, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: c.prioritized, paused: c.paused, "waiting-children": 0 } };
        }
        return out;
      }),
      getWindowMetrics: vi.fn(async (requests: WindowMetricsRequest[]) => {
        if (failingConnection === row.id) throw new Error("ECONNREFUSED");
        const out: Record<string, unknown> = {};
        for (const r of requests) {
          const q = queues.get(r.queue);
          out[r.queue] = {
            hasMetrics: !!q?.window,
            rates: r.rateWindows.map((w) => ({ windowMinutes: w, completed: q?.window?.completed ?? 0, failed: q?.window?.failed ?? 0, coveredMinutes: w })),
            durations: r.durationWindows.map((w) => ({
              windowMinutes: w,
              sampled: q?.duration?.sampled ?? 0,
              p50Ms: q?.duration ? q.duration.p50Ms : null,
              p95Ms: q?.duration ? q.duration.p95Ms : null,
            })),
            collectedAt: now,
          };
        }
        return out;
      }),
      // The zset window read must never be reached by an error rule again.
      getWindowCounts: vi.fn(async () => {
        throw new Error("getWindowCounts must not be used by alerts: it lies under removeOnComplete");
      }),
    };
  }
  const inspectors = new Map(CONNECTIONS.map((c) => [c.id, inspectorFor(c)]));

  let now = T0;
  const events: Array<{ alertId: string; status: string; message: string; value: number | null; queueName: string | null }> = [];
  const delivered: Array<{ status: string }> = [];
  let rows: AlertRow[] = [];
  let folderQueues: Array<{ connectionId: string; queueName: string }> = [];
  let connectionListError: Error | null = null;

  const alerts = {
    listRows: vi.fn(async () => rows),
    setState: vi.fn(async (id: string, s: { firing: boolean; lastFiredAt: Date | null }) => {
      // The row IS the state, exactly like MySQL.
      const row = rows.find((r) => r.id === id)!;
      row.firing = s.firing;
      row.lastFiredAt = s.lastFiredAt;
    }),
    recordEvent: vi.fn(async (e: (typeof events)[number]) => {
      events.push(e);
    }),
    pruneEvents: vi.fn(async () => undefined),
  };

  const engine = new AlertsEngine({
    config: { alertsInterval: 15, publicUrl: "http://localhost:3000" } as never,
    alerts: alerts as never,
    connections: {
      getRow: vi.fn(async (id: string) => {
        const c = CONNECTIONS.find((x) => x.id === id);
        if (!c) throw new Error("not found");
        return c;
      }),
      listRows: vi.fn(async () => {
        if (connectionListError) throw connectionListError;
        return CONNECTIONS;
      }),
      hiddenQueueNames: vi.fn(async (id: string) => hidden.get(id) ?? new Set<string>()),
      inspectorFor: (row: { id: string }) => inspectors.get(row.id) as never,
    } as never,
    folders: { get: vi.fn(async () => ({ id: "f1", name: "Payments", queues: folderQueues })) } as never,
    edition: { getEdition: () => ({ features: { alerts: true } }) } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    fetch: vi.fn(async () => {
      delivered.push({ status: "sent" });
      return new Response("ok", { status: 200 });
    }) as never,
  });

  function rule(id: string, scope: AlertScope, condition: AlertCondition, overrides: Partial<AlertRow> = {}): AlertRow {
    const cols =
      scope.type === "queue"
        ? { scopeType: "queue", connectionId: scope.connectionId, queueName: scope.queueName, folderId: null }
        : scope.type === "folder"
          ? { scopeType: "folder", connectionId: null, queueName: null, folderId: scope.folderId }
          : scope.type === "connection"
            ? { scopeType: "connection", connectionId: scope.connectionId, queueName: null, folderId: null }
            : { scopeType: "global", connectionId: null, queueName: null, folderId: null };
    return {
      id,
      name: id,
      enabled: true,
      ...cols,
      condition,
      channels: [{ type: "webhook", url: "https://example.com/hook" }],
      cooldownMinutes: 30,
      createdAt: new Date(T0),
      lastFiredAt: null,
      firing: false,
      ...overrides,
    } as AlertRow;
  }

  return {
    engine,
    inspectors,
    events,
    delivered,
    hidden,
    queue(name: string, q: FakeQueue, connectionId = "conn-1") {
      redis.get(connectionId)!.set(name, q);
    },
    failConnection(id: string | null) {
      failingConnection = id;
    },
    /** the database read of all connections fails (database restarting) */
    failConnectionList(err: Error | null) {
      connectionListError = err;
    },
    setRules(...r: AlertRow[]) {
      rows = r;
    },
    rule,
    /** the single queue rule most tests use */
    setAlert(condition: AlertCondition, overrides: Partial<AlertRow> = {}) {
      rows = [rule("alert-1", { type: "queue", connectionId: "conn-1", queueName: "payments" }, condition, overrides)];
    },
    setFolderAlert(condition: AlertCondition, queueNames: string[]) {
      folderQueues = queueNames.map((queueName) => ({ connectionId: "conn-1", queueName }));
      rows = [rule("alert-1", { type: "folder", folderId: "f1" }, condition)];
    },
    row: (id = "alert-1") => rows.find((r) => r.id === id)!,
    async tickAt(t: number) {
      now = t;
      vi.setSystemTime(t);
      await engine.tick();
    },
    measurement: (id = "alert-1") => engine.measurementOf(id),
  };
}

const rate = (percent: number, windowMinutes = 5, minSample = 20): AlertCondition => ({ kind: "failed_rate_above", percent, windowMinutes, minSample });
const failedAbove = (threshold: number, windowMinutes = 5): AlertCondition => ({ kind: "failed_above", threshold, windowMinutes });
const slow = (seconds: number, percentile: 50 | 95 = 95): AlertCondition => ({ kind: "duration_above", seconds, percentile, windowMinutes: 15, minSample: 5 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

describe("error rules are measured from BullMQ metrics windows, never from the zsets", () => {
  it("does not fire on a healthy queue that prunes its completed jobs (THE bug)", async () => {
    const w = fakeWorld();
    // 300 ok / 15 failed in the window = 4.8%. ZCOUNT would say 23.1%.
    w.queue("payments", { window: { completed: 300, failed: 15 } });
    w.setAlert(rate(10, 5));
    await w.tickAt(T0);

    expect(w.measurement()).toMatchObject({ source: "metrics", state: "ok", windowCoveredMs: 5 * MIN });
    expect(w.row().firing).toBe(false);
    expect(w.inspectors.get("conn-1")!.getWindowCounts).not.toHaveBeenCalled();
  });

  it("judges on the FIRST tick: a restart does not blind the rule for a whole window", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 30, failed: 20 } });
    w.setAlert(rate(10, 60));
    await w.tickAt(T0);
    expect(w.row().firing).toBe(true);
    expect(w.events.find((e) => e.status === "fired")?.value).toBeCloseTo(40, 0);
  });

  it("fires on a burst and resolves when the window is clean again", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 30, failed: 20 } });
    w.setAlert(failedAbove(5, 1));
    await w.tickAt(T0);
    expect(w.row().firing).toBe(true);

    w.queue("payments", { window: { completed: 60, failed: 1 } });
    await w.tickAt(T0 + MIN);
    expect(w.row().firing).toBe(false);
    expect(w.events.some((e) => e.status === "resolved")).toBe(true);
  });

  it("keeps state when Redis cannot be read, instead of resolving", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 10, failed: 40 } });
    w.setAlert(failedAbove(5, 1), { firing: true, lastFiredAt: new Date(T0 - MIN) });
    w.failConnection("conn-1");
    await w.tickAt(T0);
    expect(w.row().firing).toBe(true);
    expect(w.events).toHaveLength(0);
  });
});

describe("a queue without metrics", () => {
  it("makes the rule visibly inert: one event, no firing, no delivery, listed as unmeasured", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: null });
    w.setAlert(rate(10, 5));
    await w.tickAt(T0);

    expect(w.measurement()).toMatchObject({ source: "metrics", state: "no_metrics" });
    expect(w.row().firing).toBe(false);
    const notices = w.events.filter((e) => e.status === "no_metrics");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain("maxDataPoints");
    expect(w.delivered).toHaveLength(0);
    expect(w.engine.attention().unmeasured).toEqual([{ connectionId: "conn-1", queueName: "payments", reason: "no_metrics" }]);
  });

  it("does not repeat the notice every tick (cooldown), but does remind later", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: null });
    w.setAlert(rate(10, 5), { cooldownMinutes: 30 });
    for (let i = 0; i < 20; i++) await w.tickAt(T0 + i * 15_000);
    expect(w.events.filter((e) => e.status === "no_metrics")).toHaveLength(1);
    await w.tickAt(T0 + 31 * MIN);
    expect(w.events.filter((e) => e.status === "no_metrics")).toHaveLength(2);
  });

  it("a folder rule measures the queues it can and names the ones it cannot", async () => {
    const w = fakeWorld();
    w.queue("with-metrics", { window: { completed: 10, failed: 40 } });
    w.queue("no-metrics", { window: null });
    w.setFolderAlert(rate(10, 1), ["with-metrics", "no-metrics"]);
    await w.tickAt(T0);

    const m = w.measurement();
    expect(m?.state).toBe("ok");
    expect(m?.queuesWithoutMetrics).toEqual(["no-metrics"]);
    expect(w.row().firing).toBe(true);
    expect(w.events.find((e) => e.status === "fired")?.queueName).toBe("with-metrics");
  });
});

describe("processing time (duration_above)", () => {
  it("fires on the configured percentile and reports seconds", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 50, failed: 0 }, duration: { sampled: 50, p50Ms: 800, p95Ms: 4_200 } });
    w.setAlert(slow(2));
    await w.tickAt(T0);
    expect(w.row().firing).toBe(true);
    expect(w.events.find((e) => e.status === "fired")?.value).toBe(4.2);
    expect(w.engine.attention().findings[0]).toMatchObject({ kind: "duration_above", value: 4.2, threshold: 2, unit: "s", percentile: 95 });
  });

  it("p50 of the same sample is below the bar", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 50, failed: 0 }, duration: { sampled: 50, p50Ms: 800, p95Ms: 4_200 } });
    w.setAlert(slow(2, 50));
    await w.tickAt(T0);
    expect(w.row().firing).toBe(false);
  });

  it("does not judge on fewer completed jobs than minSample", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 2, failed: 0 }, duration: { sampled: 2, p50Ms: 60_000, p95Ms: 60_000 } });
    w.setAlert(slow(2));
    await w.tickAt(T0);
    expect(w.row().firing).toBe(false);
    expect(w.engine.attention().findings).toHaveLength(0);
  });

  it("works on a queue without metrics: durations come from the completed jobs, not the counters", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: null, duration: { sampled: 20, p50Ms: 5_000, p95Ms: 9_000 } });
    w.setAlert(slow(2));
    await w.tickAt(T0);
    expect(w.row().firing).toBe(true);
  });
});

describe("wide scopes", () => {
  it("a global rule covers every queue on every connection, except hidden ones", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 10, failed: 40 } }, "conn-1");
    w.queue("emails", { window: { completed: 100, failed: 0 } }, "conn-1");
    w.queue("import", { window: { completed: 10, failed: 30 } }, "conn-2");
    w.queue("legacy", { window: { completed: 0, failed: 90 } }, "conn-2");
    w.hidden.set("conn-2", new Set(["legacy"]));
    w.setRules(w.rule("g", { type: "global" }, rate(10, 15)));
    await w.tickAt(T0);

    const flagged = w.engine.attention().findings.map((f) => `${f.connectionId}/${f.queueName}`).sort();
    expect(flagged).toEqual(["conn-1/payments", "conn-2/import"]);
    // one read per connection, not per queue
    expect(w.inspectors.get("conn-1")!.getWindowMetrics).toHaveBeenCalledTimes(1);
    expect(w.inspectors.get("conn-2")!.getWindowMetrics).toHaveBeenCalledTimes(1);
    // the rule fires once, on its worst queue
    expect(w.events.filter((e) => e.status === "fired")).toHaveLength(1);
    expect(w.events.find((e) => e.status === "fired")?.queueName).toBe("payments");
  });

  it("a failed connection list is a failed tick, not an unhandled rejection that kills the process", async () => {
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const w = fakeWorld();
      w.setRules(w.rule("g", { type: "global" }, rate(10, 15)));
      w.failConnectionList(new Error("Pool is closed."));
      await w.engine.tick();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a connection rule stays on its connection", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 10, failed: 40 } }, "conn-1");
    w.queue("import", { window: { completed: 10, failed: 30 } }, "conn-2");
    w.setRules(w.rule("c2", { type: "connection", connectionId: "conn-2" }, rate(10, 15)));
    await w.tickAt(T0);
    expect(w.engine.attention().findings.map((f) => f.queueName)).toEqual(["import"]);
    expect(w.inspectors.get("conn-1")!.getWindowMetrics).not.toHaveBeenCalled();
  });
});

describe("most specific rule wins, per condition kind", () => {
  it("a queue rule replaces the global one for that queue only", async () => {
    const w = fakeWorld();
    // 20% failure on both queues
    w.queue("importer", { window: { completed: 80, failed: 20 } });
    w.queue("payments", { window: { completed: 80, failed: 20 } });
    w.setRules(
      w.rule("global-5", { type: "global" }, rate(5, 15)),
      w.rule("importer-30", { type: "queue", connectionId: "conn-1", queueName: "importer" }, rate(30, 15)),
    );
    await w.tickAt(T0);

    const findings = w.engine.attention().findings;
    // payments breaks the global 5%; importer is judged by its own 30% and passes
    expect(findings.map((f) => `${f.alertId}:${f.queueName}`)).toEqual(["global-5:payments"]);
    expect(w.row("importer-30").firing).toBe(false);
  });

  it("different kinds do not override each other", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 80, failed: 20 }, counts: { waiting: 5_000, paused: 0, prioritized: 0 } });
    w.setRules(
      w.rule("global-rate", { type: "global" }, rate(5, 15)),
      w.rule("payments-waiting", { type: "queue", connectionId: "conn-1", queueName: "payments" }, { kind: "waiting_above", threshold: 1_000 }),
    );
    await w.tickAt(T0);
    expect(w.engine.attention().findings.map((f) => f.alertId).sort()).toEqual(["global-rate", "payments-waiting"]);
  });

  it("applyOverrides keeps same-level rules together and judges a repeated queue once", () => {
    const t = { connectionId: "c", queueName: "q" };
    const rows = [
      { scopeType: "folder" as const, condition: rate(5) },
      { scopeType: "folder" as const, condition: rate(10) },
      { scopeType: "global" as const, condition: rate(1) },
    ];
    const out = applyOverrides(rows, [{ targets: [t, t] }, { targets: [t] }, { targets: [t] }]);
    expect(out).toEqual([[t], [t], []]);
  });
});

describe("dashboard-only rules (no channels)", () => {
  it("flag the queue and record the event, but deliver nothing", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 10, failed: 40 } });
    w.setAlert(rate(10, 5), { channels: [] });
    await w.tickAt(T0);
    expect(w.row().firing).toBe(true);
    expect(w.events.some((e) => e.status === "fired")).toBe(true);
    expect(w.delivered).toHaveLength(0);
    expect(w.engine.attention().findings[0]).toMatchObject({ notifies: false, queueName: "payments" });
  });
});

describe("waiting_above is a gauge and excludes paused", () => {
  it("does not fire when a queue is paused for maintenance", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: null, counts: { waiting: 0, paused: 5_000, prioritized: 0 } });
    w.setAlert({ kind: "waiting_above", threshold: 100 });
    await w.tickAt(T0);
    expect(w.row().firing).toBe(false);
    expect(w.measurement()).toMatchObject({ source: "counts", state: "ok" });
  });

  it("counts prioritized as real backlog", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: null, counts: { waiting: 60, paused: 0, prioritized: 60 } });
    w.setAlert({ kind: "waiting_above", threshold: 100 });
    await w.tickAt(T0);
    expect(w.row().firing).toBe(true);
    expect(w.events.find((e) => e.status === "fired")?.value).toBe(120);
  });
});

describe("attention snapshot", () => {
  it("is empty and stamped when there are no rules", async () => {
    const w = fakeWorld();
    w.setRules();
    await w.tickAt(T0);
    expect(w.engine.attention()).toEqual({ evaluatedAt: new Date(T0).toISOString(), rules: 0, findings: [], unmeasured: [] });
  });

  it("forget drops a deleted rule's findings immediately", async () => {
    const w = fakeWorld();
    w.queue("payments", { window: { completed: 10, failed: 40 } });
    w.setAlert(rate(10, 5));
    await w.tickAt(T0);
    expect(w.engine.attention().findings).toHaveLength(1);
    w.engine.forget("alert-1");
    expect(w.engine.attention().findings).toHaveLength(0);
    expect(w.measurement()).toBeUndefined();
  });
});

describe("summarise", () => {
  const ok = (state: Sample["state"]): Sample => ({ breached: false, value: 1, threshold: 5, unit: "jobs", state });

  it("is ok when at least one queue is measurable, and names the rest", () => {
    const m = summarise(failedAbove(5), [ok("ok"), ok("no_metrics")], ["b"], 300_000);
    expect(m).toMatchObject({ source: "metrics", state: "ok", queuesWithoutMetrics: ["b"], windowCoveredMs: 300_000 });
  });

  it("prefers no_metrics over warming_up when nothing is measurable (it is the actionable one)", () => {
    const m = summarise(failedAbove(5), [ok("warming_up"), ok("no_metrics")], ["b"], null);
    expect(m).toMatchObject({ state: "no_metrics", windowCoveredMs: null });
  });

  it("marks the waiting gauge as counts-sourced", () => {
    const m = summarise({ kind: "waiting_above", threshold: 5 }, [ok("ok")], [], null);
    expect(m.source).toBe("counts");
  });
});

/** The DTO the web consumes must carry the measurement, not just firing. */
describe("Alert DTO contract", () => {
  it("measurement is part of the shared Alert type, and channels may be empty", () => {
    const a: Alert = {
      id: "a",
      name: "n",
      enabled: true,
      scope: { type: "global" },
      condition: failedAbove(5),
      channels: [],
      cooldownMinutes: 30,
      createdAt: new Date(T0).toISOString(),
      lastFiredAt: null,
      firing: false,
      measurement: { source: "metrics", state: "no_metrics", windowCoveredMs: null },
    };
    expect(a.measurement?.state).toBe("no_metrics");
  });
});
