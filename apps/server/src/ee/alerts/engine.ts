/**
 * Alert evaluation loop, and the source of the Overview's "Needs attention" in
 * Pro. Runs every BULLPANE_ALERTS_INTERVAL seconds while the edition has
 * alerts (a license or DEMO_MODE).
 *
 * ONE RULE SYSTEM, TWO OUTPUTS. An alert is a rule: a scope (queue, folder,
 * connection or every queue), a condition and zero or more channels. Every
 * tick measures each rule on each queue it covers; the queues that breach are
 * the Needs attention findings (`attention()`), and the rule as a whole fires
 * and notifies when any of them breaches. A rule with no channels is
 * "dashboard only": it flags and records events, it notifies nobody.
 *
 * MOST SPECIFIC WINS. For one queue and one condition kind, only the rules at
 * the most specific scope level apply (queue > folder > connection > global).
 * "Failure rate > 5% everywhere, > 30% for the importer" is two rules, and the
 * importer is judged by the second one only.
 *
 * HOW ERROR RULES MEASURE. From BullMQ's per-minute metrics lists, read in one
 * Lua call per queue (lua/windowMetrics.lua), never from the completed/failed
 * sorted sets: those only hold what retention kept, so a queue with
 * `removeOnComplete` reads as failing (4.8% real read as 23.1%). There is no
 * fallback: a queue whose Worker keeps no metrics gets no error finding, and
 * the rule says so. Because the lists are per minute and written by BullMQ,
 * the window is exact from the first tick — a restart does not blind the
 * dashboard for `windowMinutes`.
 *
 * `waiting_above` is a gauge from the state counts. `duration_above` samples the
 * newest completed jobs in the window (bounded), because BullMQ metrics hold
 * counts, not durations.
 *
 * COST PER TICK. Per connection: one discovery + one pipelined stats call
 * (shared, only when a rule needs counts or a wide scope) and one pipelined
 * windowMetrics call covering every queue any rule measures. Never per rule.
 */
import type {
  Alert,
  AlertCondition,
  AlertMeasurement,
  AlertScope,
  AttentionFinding,
  AttentionSnapshot,
  AttentionUnmeasured,
  FolderQueueRef,
} from "@bullpane/shared";
import { ALERT_SCOPE_SPECIFICITY, DURATION_SAMPLE_MAX, isErrorAlertKind } from "@bullpane/shared";
import type { Inspector, QueueStats, WindowMetrics } from "@bullpane/redis-inspector";
import type { Config } from "../../config";
import type { AlertRow, ConnectionRow } from "../../db/schema";
import type { AlertsService } from "../services/alerts";
import type { ConnectionsService } from "../../services/connections";
import type { EditionService } from "../../services/edition";
import type { FoldersService } from "../services/folders";
import { alertLink, deliverToAll, type DeliveryResult, type FetchLike } from "./deliver";
import { describeCondition, evaluateAlert, formatMessage, measure, type Measurement, type Sample } from "./evaluate";
import { scopeOf, toAlertDto } from "../services/alerts";

export interface EngineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

/** One queue a rule watches. */
export type Target = FolderQueueRef;

interface Discovered {
  names: string[];
  stats: Record<string, QueueStats>;
}

interface TickCache {
  connections: Map<string, Promise<ConnectionRow | null>>;
  allConnections: Promise<ConnectionRow[]> | null;
  discovered: Map<string, Promise<Discovered>>;
  singleStats: Map<string, Promise<QueueStats | undefined>>;
  hidden: Map<string, Promise<Set<string>>>;
  /** windowMetrics per connection, filled once per tick before rules are judged */
  windows: Map<string, Record<string, WindowMetrics> | null>;
}

interface ResolvedScope {
  targets: Target[];
  /** `folder "Payments"`, `connection "Prod"`, `every queue`; null for a queue rule */
  label: string | null;
  folderName: string | null;
}

interface Measured {
  sample: Sample;
  /** the queue the reported value belongs to (worst queue); null when inconclusive */
  target: Target | null;
  measurement: AlertMeasurement;
}

/** A per-queue sample, plus whether Redis could be read at all. */
interface TargetSample {
  target: Target;
  sample: Sample;
  /** the connection or script errored: unknown, and not a reason to resolve */
  unreachable: boolean;
  noMetrics: boolean;
  coveredMs: number | null;
}

const EVENT_RETENTION_DAYS = 30;
/** How many unmeasurable queues a notice names before "and N more". */
const NOTICE_MAX_NAMES = 10;

export class AlertsEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** a change arrived while a tick was running: run again right after */
  private rerun = false;
  private ticks = 0;
  /** last measurement state per rule, so the DTO can show it and the UI stop lying */
  private readonly lastMeasurement = new Map<string, AlertMeasurement>();
  /** Needs attention, as of the last completed tick */
  private snapshot: AttentionSnapshot = { evaluatedAt: null, rules: 0, findings: [], unmeasured: [] };
  /**
   * When we last told the owner that a rule cannot measure, per rule. Rate
   * limited to the rule's own cooldown so the events table does not get one
   * row every 15 s forever.
   */
  private readonly noticedAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      config: Config;
      alerts: AlertsService;
      connections: ConnectionsService;
      folders: FoldersService;
      edition: EditionService;
      log: EngineLogger;
      fetch?: FetchLike;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const everyMs = this.deps.config.alertsInterval * 1000;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
    this.deps.log.info({ intervalSec: this.deps.config.alertsInterval }, "alerts engine started");
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * What the last tick could see for this rule, for GET /alerts. `undefined`
   * before the first tick (or when alerts are locked), which the UI shows as
   * "not evaluated yet" rather than as a green "ok".
   */
  measurementOf(alertId: string): AlertMeasurement | undefined {
    return this.lastMeasurement.get(alertId);
  }

  /** Needs attention for GET /attention: in memory, no Redis read. */
  attention(): AttentionSnapshot {
    return this.snapshot;
  }

  /** A rule was deleted or re-scoped: what we remembered about it is meaningless. */
  forget(alertId: string): void {
    this.lastMeasurement.delete(alertId);
    this.noticedAt.delete(alertId);
    this.snapshot = { ...this.snapshot, findings: this.snapshot.findings.filter((f) => f.alertId !== alertId) };
  }

  /**
   * Re-evaluate soon after a rule changed, so the Overview does not wait a
   * whole interval to reflect it. Coalesced with a running tick.
   */
  refresh(): void {
    if (this.running) this.rerun = true;
    else void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    if (!this.deps.edition.getEdition().features.alerts) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const rows = await this.deps.alerts.listRows({ enabledOnly: true });
      await this.evaluateAll(rows, startedAt);
      this.ticks += 1;
      if (this.ticks % 240 === 1) {
        await this.deps.alerts.pruneEvents(new Date(startedAt - EVENT_RETENTION_DAYS * 86_400_000));
      }
    } catch (err) {
      this.deps.log.error({ err: errorText(err) }, "alerts tick failed");
    } finally {
      this.running = false;
    }
    if (this.rerun) {
      this.rerun = false;
      void this.tick();
    }
  }

  /** POST /alerts/:id/test — synthetic event to every channel. */
  async sendTest(row: AlertRow): Promise<DeliveryResult[]> {
    const scope = await this.resolveScope(row, newCache());
    const first = scope.targets[0] ?? null;
    const connection = first ? await this.deps.connections.getRow(first.connectionId).catch(() => null) : null;
    const alert = toAlertDto(row);
    const sample: Sample = { breached: true, value: null, threshold: thresholdOf(row.condition), unit: null, state: "ok" };
    const message = formatMessage({
      kind: row.condition.kind,
      condition: row.condition,
      status: "test",
      queueName: first?.queueName ?? null,
      connectionName: connection?.name ?? null,
      scopeLabel: scope.label,
      sample,
    });
    return deliverToAll(
      row.channels,
      {
        alert,
        status: "test",
        message,
        value: null,
        threshold: sample.threshold,
        queueName: first?.queueName ?? null,
        connectionName: connection?.name ?? null,
        folderName: scope.folderName,
        url: alertLink(this.deps.config.publicUrl, first?.connectionId ?? null, first?.queueName ?? null),
      },
      this.deps.fetch,
    );
  }

  // -------------------------------------------------------------------------
  // one tick
  // -------------------------------------------------------------------------

  private async evaluateAll(rows: AlertRow[], now: number): Promise<void> {
    if (rows.length === 0) {
      this.snapshot = { evaluatedAt: new Date(now).toISOString(), rules: 0, findings: [], unmeasured: [] };
      return;
    }
    const cache = newCache();

    // 1. Who does each rule cover?
    const scopes = await Promise.all(
      rows.map((row) =>
        this.resolveScope(row, cache).catch((err: unknown) => {
          this.deps.log.warn({ alertId: row.id, err: errorText(err) }, "alert scope could not be resolved");
          return null;
        }),
      ),
    );

    // 2. Most specific wins, per (condition kind, queue).
    const effective = applyOverrides(rows, scopes);

    // 3. One windowMetrics pipeline per connection, for everything any rule measures.
    await this.loadWindows(rows, effective, cache, now);

    // 4. Judge every rule on its queues.
    const findings: AttentionFinding[] = [];
    const unmeasured = new Map<string, AttentionUnmeasured>();
    await Promise.all(
      rows.map(async (row, i) => {
        const scope = scopes[i];
        const targets = effective[i] ?? [];
        if (!scope) return;
        try {
          const perTarget = await this.measureTargets(row, targets, cache);
          for (const t of perTarget) {
            if (t.sample.breached === true && t.sample.value !== null && t.sample.threshold !== null) {
              findings.push(toFinding(row, t));
            }
            if (t.noMetrics) {
              const key = `${t.target.connectionId}\u0000${t.target.queueName}`;
              unmeasured.set(key, { connectionId: t.target.connectionId, queueName: t.target.queueName, reason: "no_metrics" });
            }
          }
          await this.decide(row, scope, targets, perTarget, cache, now);
        } catch (err) {
          this.deps.log.warn({ alertId: row.id, err: errorText(err) }, "alert evaluation failed");
        }
      }),
    );

    this.snapshot = {
      evaluatedAt: new Date(now).toISOString(),
      rules: rows.length,
      findings,
      unmeasured: [...unmeasured.values()],
    };
  }

  /** Rule-level state machine + notifications, from the per-queue samples. */
  private async decide(row: AlertRow, scope: ResolvedScope, targets: Target[], perTarget: TargetSample[], cache: TickCache, now: number): Promise<void> {
    if (targets.length === 0) {
      // Empty folder, or every queue is overridden by a more specific rule.
      this.lastMeasurement.set(row.id, { source: isErrorAlertKind(row.condition.kind) ? "metrics" : "counts", state: "ok", windowCoveredMs: null });
      if (row.firing) await this.transition(row, scope, "resolve", { sample: emptySample(row.condition), target: null }, cache, now);
      return;
    }
    // Redis unreachable for every queue: keep state, try next tick.
    if (perTarget.every((t) => t.unreachable)) return;

    const measured = summariseTargets(row.condition, perTarget);
    this.lastMeasurement.set(row.id, measured.measurement);

    if (measured.measurement.state === "no_metrics") {
      await this.noticeNoMetrics(row, scope, measured.measurement, cache, now);
      return; // never fire, never resolve: we know nothing about these queues
    }

    const decision = evaluateAlert(
      { firing: row.firing, lastFiredAt: row.lastFiredAt, cooldownMinutes: row.cooldownMinutes },
      measured.sample,
      now,
    );
    if (decision.action === "none") return;
    await this.transition(row, scope, decision.action, measured, cache, now, decision);
  }

  private async transition(
    row: AlertRow,
    scope: ResolvedScope,
    action: "fire" | "renotify" | "resolve",
    measured: Pick<Measured, "sample" | "target">,
    cache: TickCache,
    now: number,
    decision?: { firing: boolean; lastFiredAt: number | null },
  ): Promise<void> {
    const status = action === "resolve" ? "resolved" : "fired";
    const target = measured.target ?? scope.targets[0] ?? null;
    const connection = target ? await this.connection(target.connectionId, cache) : null;
    const queueName = target?.queueName ?? null;
    const connectionId = target?.connectionId ?? null;
    const message = formatMessage({
      kind: row.condition.kind,
      condition: row.condition,
      status,
      queueName,
      connectionName: connection?.name ?? null,
      scopeLabel: scope.label,
      sample: measured.sample,
    });

    const firing = decision?.firing ?? false;
    const lastFiredAt = decision ? decision.lastFiredAt : row.lastFiredAt ? row.lastFiredAt.getTime() : null;
    await this.deps.alerts.setState(row.id, { firing, lastFiredAt: lastFiredAt === null ? null : new Date(lastFiredAt) });
    await this.deps.alerts.recordEvent({
      alertId: row.id,
      alertName: row.name,
      connectionId,
      queueName,
      kind: row.condition.kind,
      status,
      message,
      value: measured.sample.value,
    });
    this.deps.log.info({ alertId: row.id, action, value: measured.sample.value, at: now }, message);

    // Dashboard-only rule: the event above is the whole outcome.
    if (row.channels.length === 0) return;

    const alert: Alert = toAlertDto(row);
    const results = await deliverToAll(
      row.channels,
      {
        alert,
        status,
        message,
        value: measured.sample.value,
        threshold: measured.sample.threshold,
        queueName,
        connectionName: connection?.name ?? null,
        folderName: scope.folderName,
        url: alertLink(this.deps.config.publicUrl, connectionId, queueName),
      },
      this.deps.fetch,
    );
    for (const r of results) {
      if (r.ok) continue;
      await this.deps.alerts.recordEvent({
        alertId: row.id,
        alertName: row.name,
        connectionId,
        queueName,
        kind: row.condition.kind,
        status: "delivery_failed",
        message: `Delivery to ${r.channel} failed: ${r.error ?? "unknown error"}`,
        value: measured.sample.value,
      });
      this.deps.log.warn({ alertId: row.id, channel: r.channel, error: r.error }, "alert delivery failed");
    }
  }

  // -------------------------------------------------------------------------
  // scope resolution
  // -------------------------------------------------------------------------

  /**
   * Queue → that queue. Folder → its queues (any connection, hidden ones
   * included: the admin put them there by name). Connection / global → every
   * discovered queue, minus hidden ones, which the admin said to stop seeing.
   */
  private async resolveScope(row: AlertRow, cache: TickCache): Promise<ResolvedScope> {
    const scope: AlertScope = scopeOf(row);
    switch (scope.type) {
      case "queue":
        return { targets: [{ connectionId: scope.connectionId, queueName: scope.queueName }], label: null, folderName: null };
      case "folder": {
        const folder = await this.deps.folders.get(scope.folderId);
        return { targets: folder.queues, label: `folder "${folder.name}"`, folderName: folder.name };
      }
      case "connection": {
        const connection = await this.connection(scope.connectionId, cache);
        if (!connection) throw new Error("connection not found");
        return { targets: await this.visibleQueues(connection, cache), label: `connection "${connection.name}"`, folderName: null };
      }
      case "global": {
        const all = await this.allConnections(cache);
        const lists = await Promise.all(all.map((c) => this.visibleQueues(c, cache).catch(() => [] as Target[])));
        return { targets: lists.flat(), label: "every queue", folderName: null };
      }
    }
  }

  private async visibleQueues(connection: ConnectionRow, cache: TickCache): Promise<Target[]> {
    const inspector = this.deps.connections.inspectorFor(connection);
    const [{ names }, hidden] = await Promise.all([this.discover(inspector, cache), this.hidden(connection.id, cache)]);
    return names.filter((n) => !hidden.has(n)).map((queueName) => ({ connectionId: connection.id, queueName }));
  }

  private allConnections(cache: TickCache): Promise<ConnectionRow[]> {
    if (!cache.allConnections) {
      cache.allConnections = this.deps.connections.listRows();
      // Seed the per-id cache so later lookups do not hit the database again.
      // The catch matters: this derived promise has no other listener, so a
      // failed read (database restarting) would be an unhandled rejection,
      // which kills the process. The caller awaiting `allConnections` still
      // sees the error and the tick logs it.
      cache.allConnections
        .then((rows) => {
          for (const r of rows) if (!cache.connections.has(r.id)) cache.connections.set(r.id, Promise.resolve(r));
        })
        .catch(() => undefined);
    }
    return cache.allConnections;
  }

  private hidden(connectionId: string, cache: TickCache): Promise<Set<string>> {
    let p = cache.hidden.get(connectionId);
    if (!p) {
      p = this.deps.connections.hiddenQueueNames(connectionId).catch(() => new Set<string>());
      cache.hidden.set(connectionId, p);
    }
    return p;
  }

  private connection(id: string, cache: TickCache): Promise<ConnectionRow | null> {
    let p = cache.connections.get(id);
    if (!p) {
      p = this.deps.connections.getRow(id).catch(() => null);
      cache.connections.set(id, p);
    }
    return p;
  }

  /** One discovery + one pipelined stats call per connection per tick. */
  private discover(inspector: Inspector, cache: TickCache): Promise<Discovered> {
    let p = cache.discovered.get(inspector.config.id);
    if (!p) {
      p = (async () => {
        const names = await inspector.discoverQueues();
        const stats = names.length ? await inspector.getQueueStats(names) : {};
        return { names, stats };
      })();
      cache.discovered.set(inspector.config.id, p);
    }
    return p;
  }

  private async queueStats(inspector: Inspector, queue: string, cache: TickCache): Promise<QueueStats | undefined> {
    const all = await this.discover(inspector, cache);
    if (all.stats[queue]) return all.stats[queue];
    // Not discovered (filtered out or brand new): one direct call, still shared per tick.
    const key = `${inspector.config.id}:${queue}`;
    let p = cache.singleStats.get(key);
    if (!p) {
      p = inspector.getQueueStats([queue]).then((s) => s[queue]);
      cache.singleStats.set(key, p);
    }
    return p;
  }

  // -------------------------------------------------------------------------
  // measurement
  // -------------------------------------------------------------------------

  /**
   * Collect every (queue, window) any rule needs and read them in ONE
   * pipelined call per connection. A connection that errors is recorded as
   * null so its rules keep their state instead of resolving.
   */
  private async loadWindows(rows: AlertRow[], effective: Target[][], cache: TickCache, _now: number): Promise<void> {
    const wanted = new Map<string, Map<string, { rate: Set<number>; duration: Set<number> }>>();
    rows.forEach((row, i) => {
      const c = row.condition;
      if (c.kind === "waiting_above") return;
      for (const t of effective[i] ?? []) {
        let perConn = wanted.get(t.connectionId);
        if (!perConn) wanted.set(t.connectionId, (perConn = new Map()));
        let req = perConn.get(t.queueName);
        if (!req) perConn.set(t.queueName, (req = { rate: new Set(), duration: new Set() }));
        if (c.kind === "duration_above") req.duration.add(c.windowMinutes);
        else req.rate.add(c.windowMinutes);
      }
    });

    await Promise.all(
      [...wanted].map(async ([connectionId, queues]) => {
        const connection = await this.connection(connectionId, cache);
        if (!connection) {
          cache.windows.set(connectionId, null);
          return;
        }
        try {
          const inspector = this.deps.connections.inspectorFor(connection);
          const requests = [...queues].map(([queue, r]) => ({ queue, rateWindows: [...r.rate], durationWindows: [...r.duration] }));
          cache.windows.set(connectionId, await inspector.getWindowMetrics(requests, { durationSample: DURATION_SAMPLE_MAX }));
        } catch (err) {
          this.deps.log.warn({ connectionId, err: errorText(err) }, "could not read window metrics (redis error); keeping alert state");
          cache.windows.set(connectionId, null);
        }
      }),
    );
  }

  private async measureTargets(row: AlertRow, targets: Target[], cache: TickCache): Promise<TargetSample[]> {
    const condition = row.condition;
    return Promise.all(
      targets.map(async (target): Promise<TargetSample> => {
        const unknown = (unreachable: boolean): TargetSample => ({
          target,
          sample: emptySample(condition, "warming_up"),
          unreachable,
          noMetrics: false,
          coveredMs: null,
        });

        if (condition.kind === "waiting_above") {
          const connection = await this.connection(target.connectionId, cache);
          if (!connection) return unknown(true);
          try {
            const s = await this.queueStats(this.deps.connections.inspectorFor(connection), target.queueName, cache);
            /**
             * Backlog = `wait` + `prioritized`. `paused` is deliberately EXCLUDED:
             * pausing a queue for maintenance moves every waiting job into
             * `paused`, and flagging that as a backlog punishes the correct move.
             */
            const waiting = s ? s.counts.waiting + s.counts.prioritized : 0;
            return { target, sample: measure(condition, { kind: "waiting_above", waiting }), unreachable: false, noMetrics: false, coveredMs: null };
          } catch {
            return unknown(true);
          }
        }

        const windows = cache.windows.get(target.connectionId);
        if (windows === null || windows === undefined) return unknown(true);
        const wm = windows[target.queueName];
        if (!wm) return unknown(true); // script error for this queue

        if (condition.kind === "duration_above") {
          const d = wm.durations.find((x) => x.windowMinutes === condition.windowMinutes);
          const durationMs = d ? (condition.percentile === 50 ? d.p50Ms : d.p95Ms) : null;
          const m: Measurement = { kind: "duration_above", sampled: d?.sampled ?? 0, durationMs };
          return { target, sample: measure(condition, m), unreachable: false, noMetrics: false, coveredMs: null };
        }

        if (!wm.hasMetrics) {
          const m: Measurement =
            condition.kind === "failed_above"
              ? { kind: "failed_above", failed: null, state: "no_metrics" }
              : { kind: "failed_rate_above", failed: null, completed: null, state: "no_metrics" };
          return { target, sample: measure(condition, m), unreachable: false, noMetrics: true, coveredMs: null };
        }
        const r = wm.rates.find((x) => x.windowMinutes === condition.windowMinutes);
        if (!r) return unknown(false);
        const m: Measurement =
          condition.kind === "failed_above"
            ? { kind: "failed_above", failed: r.failed, state: "ok" }
            : { kind: "failed_rate_above", failed: r.failed, completed: r.completed, state: "ok" };
        return { target, sample: measure(condition, m), unreachable: false, noMetrics: false, coveredMs: r.coveredMinutes * 60_000 };
      }),
    );
  }

  /**
   * Record ONE informative event saying the rule is inert because its queues
   * collect no metrics, and how to fix it. Re-armed after the rule's own
   * cooldown. No notification is delivered: this is a configuration problem
   * for whoever reads the dashboard, not an incident.
   */
  private async noticeNoMetrics(row: AlertRow, scope: ResolvedScope, measurement: AlertMeasurement, cache: TickCache, now: number): Promise<void> {
    const last = this.noticedAt.get(row.id);
    const cooldownMs = row.cooldownMinutes * 60_000;
    if (last !== undefined && now - last < cooldownMs) return;
    this.noticedAt.set(row.id, now);

    const target = scope.targets[0] ?? null;
    const connection = target ? await this.connection(target.connectionId, cache) : null;
    const named = measurement.queuesWithoutMetrics ?? [];
    const listed = named.slice(0, NOTICE_MAX_NAMES).join(", ") + (named.length > NOTICE_MAX_NAMES ? ` and ${named.length - NOTICE_MAX_NAMES} more` : "");
    const which =
      scope.label !== null
        ? `${scope.label} — ${named.length > 0 ? `no metrics on: ${listed}` : "no queue collects metrics"}`
        : `queue "${target?.queueName ?? "?"}"`;
    const message =
      `Cannot measure ${describeCondition(row.condition)} on ${which}: BullMQ keeps no metrics counters for it, ` +
      `so failure counts would have to come from the completed/failed sorted sets — which lie whenever removeOnComplete prunes them. ` +
      `This rule is inert until metrics are on. Fix: new Worker(name, fn, { metrics: { maxDataPoints: MetricsTime.ONE_WEEK } }).`;

    await this.deps.alerts.recordEvent({
      alertId: row.id,
      alertName: row.name,
      connectionId: target?.connectionId ?? null,
      queueName: scope.label !== null ? null : target?.queueName ?? null,
      kind: row.condition.kind,
      status: "no_metrics",
      message,
      value: null,
    });
    this.deps.log.warn({ alertId: row.id, connectionName: connection?.name ?? null, queues: named.length }, "alert cannot measure: queue collects no BullMQ metrics");
  }
}

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Most specific wins: for each (condition kind, connection, queue), keep only
 * the targets of the rules at the highest specificity covering it. Rules at
 * the same level all keep the queue.
 */
export function applyOverrides(rows: Pick<AlertRow, "condition" | "scopeType">[], scopes: Array<{ targets: Target[] } | null>): Target[][] {
  const key = (kind: string, t: Target) => `${kind}\u0000${t.connectionId}\u0000${t.queueName}`;
  const best = new Map<string, number>();
  rows.forEach((row, i) => {
    const level = ALERT_SCOPE_SPECIFICITY[row.scopeType];
    for (const t of scopes[i]?.targets ?? []) {
      const k = key(row.condition.kind, t);
      if ((best.get(k) ?? -1) < level) best.set(k, level);
    }
  });
  return rows.map((row, i) => {
    const level = ALERT_SCOPE_SPECIFICITY[row.scopeType];
    // A folder may list the same queue twice across nesting; judge it once.
    const seen = new Set<string>();
    return (scopes[i]?.targets ?? []).filter((t) => {
      const k = key(row.condition.kind, t);
      if (best.get(k) !== level || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}

function summariseTargets(condition: AlertCondition, perTarget: TargetSample[]): Measured {
  const reachable = perTarget.filter((t) => !t.unreachable);
  const samples = reachable.map((t) => t.sample);
  const noMetrics = reachable.filter((t) => t.noMetrics).map((t) => t.target.queueName);
  const covered = reachable.reduce<number | null>((m, t) => (t.coveredMs === null ? m : m === null ? t.coveredMs : Math.max(m, t.coveredMs)), null);
  const worst = pickWorst(
    condition,
    reachable.map((t) => t.target),
    samples,
  );
  return { ...worst, measurement: summarise(condition, samples, noMetrics, covered) };
}

/**
 * Collapse the per-queue samples into one measurement for the DTO/UI.
 *
 * A wide rule can mix states: some queues measurable, some not. If ANY queue
 * produced a usable reading the rule is `ok` (it can still fire on that queue)
 * but the unmeasurable queues are named. Only when NOTHING is measurable does
 * the rule go `no_metrics` / `warming_up` and stop deciding altogether.
 */
export function summarise(condition: AlertCondition, samples: Sample[], queuesWithoutMetrics: string[], windowCoveredMs: number | null): AlertMeasurement {
  const source: AlertMeasurement["source"] = isErrorAlertKind(condition.kind) ? "metrics" : "counts";
  const base: AlertMeasurement = { source, state: "ok", windowCoveredMs };
  if (queuesWithoutMetrics.length > 0) base.queuesWithoutMetrics = [...queuesWithoutMetrics];
  if (samples.length === 0 || samples.some((s) => s.state === "ok")) return base;
  // nothing measurable: no_metrics wins over warming_up, it is the actionable one
  base.state = samples.some((s) => s.state === "no_metrics") ? "no_metrics" : "warming_up";
  base.windowCoveredMs = null;
  return base;
}

/**
 * A wide rule fires when ANY of its queues breaches. Report the worst one:
 * a breached queue beats a healthy one, then the highest value wins.
 * If no queue has enough data the sample is inconclusive (breached null).
 */
export function pickWorst(condition: AlertCondition, targets: Target[], samples: Sample[]): Omit<Measured, "measurement"> {
  let best: Omit<Measured, "measurement"> | null = null;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as Sample;
    if (sample.breached === null) continue;
    const target = targets[i] as Target;
    if (!best) {
      best = { sample, target };
      continue;
    }
    const bestBreached = best.sample.breached === true;
    if (sample.breached && !bestBreached) {
      best = { sample, target };
    } else if (sample.breached === bestBreached && (sample.value ?? -1) > (best.sample.value ?? -1)) {
      best = { sample, target };
    }
  }
  if (!best) {
    const state: Sample["state"] = samples.some((x) => x.state === "no_metrics")
      ? "no_metrics"
      : samples.some((x) => x.state === "warming_up")
        ? "warming_up"
        : "ok";
    return { sample: { ...emptySample(condition), state }, target: null };
  }
  return best;
}

export function thresholdOf(condition: AlertCondition): number | null {
  switch (condition.kind) {
    case "waiting_above":
    case "failed_above":
      return condition.threshold;
    case "failed_rate_above":
      return condition.percent;
    case "duration_above":
      return condition.seconds;
  }
}

function emptySample(condition: AlertCondition, state: Sample["state"] = "ok"): Sample {
  return { breached: null, value: null, threshold: thresholdOf(condition), unit: null, state };
}

function toFinding(row: AlertRow, t: TargetSample): AttentionFinding {
  const c = row.condition;
  return {
    alertId: row.id,
    alertName: row.name,
    kind: c.kind,
    scopeType: row.scopeType,
    connectionId: t.target.connectionId,
    queueName: t.target.queueName,
    value: t.sample.value as number,
    threshold: t.sample.threshold as number,
    unit: t.sample.unit ?? "jobs",
    windowMinutes: "windowMinutes" in c ? c.windowMinutes : null,
    ...(c.kind === "duration_above" ? { percentile: c.percentile } : {}),
    notifies: row.channels.length > 0,
  };
}

function newCache(): TickCache {
  return {
    connections: new Map(),
    allConnections: null,
    discovered: new Map(),
    singleStats: new Map(),
    hidden: new Map(),
    windows: new Map(),
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
