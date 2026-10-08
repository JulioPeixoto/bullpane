/**
 * Flow maps (Pro): named diagrams of the queues one process goes through.
 * Contract in docs/API.md ("Flow maps"); why maps reference queues instead of
 * reusing folders in docs/ARCHITECTURE.md and migrations/mysql/0011_flow_maps.sql.
 *
 * Manual maps live in flow_maps / flow_map_nodes / flow_map_edges. Detected maps
 * are computed from FlowsService's sampled edges (cached 30 s) and never stored.
 *
 * Cost of reading one map: per connection on it, the (cached) queue discovery,
 * ONE getQueueStats for only the queues on the map, and the cached detected
 * edges. Never a scan per node.
 */
import {
  type AddFlowMapNodeInput,
  type CreateFlowMapEdgeInput,
  type CreateFlowMapInput,
  EMPTY_COUNTS,
  type FlowEdge,
  type FlowMap,
  type FlowMapEdge,
  type FlowMapNode,
  type FlowMapNodeRef,
  type FlowMapsResponse,
  type FlowMapSummary,
  flowMapNodeId,
  type SaveFlowMapLayoutInput,
  type UpdateFlowMapInput,
} from "@bullpane/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../db";
import { type ConnectionRow, type FlowMapEdgeRow, flowMapEdges, flowMapNodes, flowMaps, type FlowMapRow } from "../../db/schema";
import { conflict, HttpError, notFound } from "../../plugins/errors";
import type { ConnectionsService } from "../../services/connections";
import { withRedis } from "../../services/inspector-errors";
import { detectedEdgeId, type FlowsService } from "./flows";

export const DETECTED_MAP_PREFIX = "detected:";
/**
 * How long a read waits for a connection's FlowProducer sample. The first sample
 * of a big keyspace can take seconds; past this budget the read answers without
 * it (`detectedComplete: false`) and the sample keeps filling the cache for the
 * next poll, instead of holding the sidebar hostage.
 */
export const DETECTED_WAIT_MS = 3_000;

const NAME_MAX = 80;

export const detectedMapReadOnly = () =>
  new HttpError(409, "detected_map_read_only", "Detected maps are computed from BullMQ flows and cannot be edited. Copy it to edit it.");

export function isDetectedMapId(id: string): boolean {
  return id.startsWith(DETECTED_MAP_PREFIX);
}

export function detectedMapId(connectionId: string, rootQueue: string): string {
  return `${DETECTED_MAP_PREFIX}${connectionId}:${rootQueue}`;
}

/** `${connectionId}:${queueName}` → ref. Split on the FIRST ":": queue names may contain ":", connection ids never do. */
export function parseNodeId(nodeId: string): FlowMapNodeRef | null {
  const i = nodeId.indexOf(":");
  if (i <= 0 || i === nodeId.length - 1) return null;
  return { connectionId: nodeId.slice(0, i), queueName: nodeId.slice(i + 1) };
}

/** A component of one connection's detected edges: the queues FlowProducer links together. */
export interface DetectedComponent {
  root: string;
  queues: string[];
  edges: FlowEdge[];
}

/**
 * Connected components (direction ignored) of 2+ queues. Edges go child → parent,
 * so the root is a queue no edge leaves: the FlowProducer parent at the top.
 * Several (or none, on a cycle): most incoming evidence, then name.
 */
export function detectedComponents(edges: FlowEdge[]): DetectedComponent[] {
  const parent = new Map<string, string>();
  const find = (q: string): string => {
    let r = q;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    // path compression keeps this linear on long chains
    let c = q;
    while (c !== r) {
      const next = parent.get(c) as string;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const e of edges) {
    for (const q of [e.from, e.to]) if (!parent.has(q)) parent.set(q, q);
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent.set(a, b);
  }

  const groups = new Map<string, { queues: string[]; edges: FlowEdge[] }>();
  for (const q of parent.keys()) {
    const r = find(q);
    const g = groups.get(r) ?? { queues: [], edges: [] };
    g.queues.push(q);
    groups.set(r, g);
  }
  for (const e of edges) groups.get(find(e.from))?.edges.push(e);

  const out: DetectedComponent[] = [];
  for (const g of groups.values()) {
    if (g.queues.length < 2) continue;
    const outgoing = new Set(g.edges.map((e) => e.from));
    const incoming = new Map<string, number>();
    for (const e of g.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + e.evidence);
    const sinks = g.queues.filter((q) => !outgoing.has(q));
    const candidates = sinks.length > 0 ? sinks : g.queues;
    candidates.sort((a, b) => (incoming.get(b) ?? 0) - (incoming.get(a) ?? 0) || a.localeCompare(b));
    out.push({ root: candidates[0] as string, queues: g.queues.sort((a, b) => a.localeCompare(b)), edges: g.edges });
  }
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/** Rejects after `ms` so a slow sample does not hold a read; the sample itself keeps running. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("still sampling")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface NodeSpec extends FlowMapNodeRef {
  x: number | null;
  y: number | null;
}

interface MapSource {
  summary: Omit<FlowMapSummary, "nodeCount" | "edgeCount">;
  nodes: NodeSpec[];
  manualEdges: FlowMapEdgeRow[];
  /** a detected map already holds its edges; manual maps read them per connection */
  detectedEdges?: FlowEdge[];
}

/**
 * On a map a detected edge points parent → child: the FlowProducer parent fans
 * out to the queues it waits for, which is how the flow reads in code. The
 * connection-level `FlowEdge` keeps child → parent (what Redis stores).
 */
function toDetectedMapEdge(connectionId: string, e: FlowEdge): FlowMapEdge {
  const from = flowMapNodeId({ connectionId, queueName: e.to });
  const to = flowMapNodeId({ connectionId, queueName: e.from });
  return { id: detectedEdgeId(from, to), from, to, source: "detected", label: null, evidence: e.evidence };
}

function toManualMapEdge(row: FlowMapEdgeRow): FlowMapEdge {
  return {
    id: row.id,
    from: flowMapNodeId({ connectionId: row.fromConnectionId, queueName: row.fromQueue }),
    to: flowMapNodeId({ connectionId: row.toConnectionId, queueName: row.toQueue }),
    source: "manual",
    label: row.label ?? null,
    evidence: 0,
  };
}

function manualSummary(row: FlowMapRow): MapSource["summary"] {
  return {
    id: row.id,
    kind: "manual",
    name: row.name,
    description: row.description ?? null,
    parentId: row.parentId ?? null,
    position: row.position,
    connectionId: null,
  };
}

function sameRef(a: FlowMapNodeRef, b: FlowMapNodeRef): boolean {
  return a.connectionId === b.connectionId && a.queueName === b.queueName;
}

export class FlowMapsService {
  constructor(
    private readonly db: Db,
    private readonly connections: ConnectionsService,
    private readonly flows: FlowsService,
  ) {}

  // ---------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------

  async list(): Promise<FlowMapsResponse> {
    const rows = await this.db.select().from(flowMaps);
    // Tree order is done here rather than in SQL: MySQL and SQLite agree on
    // NULLs-first, but not on collation, and the UI relies on a stable order.
    rows.sort(
      (a, b) =>
        (a.parentId ?? "").localeCompare(b.parentId ?? "") || a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    const nodeCount = new Map<string, number>();
    const edgeCount = new Map<string, number>();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      for (const n of await this.db.select({ mapId: flowMapNodes.mapId }).from(flowMapNodes).where(inArray(flowMapNodes.mapId, ids))) {
        nodeCount.set(n.mapId, (nodeCount.get(n.mapId) ?? 0) + 1);
      }
      for (const e of await this.db.select({ mapId: flowMapEdges.mapId }).from(flowMapEdges).where(inArray(flowMapEdges.mapId, ids))) {
        edgeCount.set(e.mapId, (edgeCount.get(e.mapId) ?? 0) + 1);
      }
    }
    // A manual map's edgeCount is its drawn edges: detected ones would need a
    // sample of every connection on every map just to print a number.
    const maps: FlowMapSummary[] = rows.map((r) => ({ ...manualSummary(r), nodeCount: nodeCount.get(r.id) ?? 0, edgeCount: edgeCount.get(r.id) ?? 0 }));

    let detectedComplete = true;
    const perConnection = await Promise.all(
      (await this.connections.listRows()).map(async (row) => {
        try {
          return { row, components: detectedComponents(await within(this.flows.detectedEdges(row), DETECTED_WAIT_MS)) };
        } catch {
          detectedComplete = false;
          return { row, components: [] };
        }
      }),
    );
    for (const { row, components } of perConnection) {
      components.forEach((c, position) => {
        maps.push({
          id: detectedMapId(row.id, c.root),
          kind: "detected",
          name: c.root,
          description: null,
          parentId: null,
          position,
          connectionId: row.id,
          nodeCount: c.queues.length,
          edgeCount: c.edges.length,
        });
      });
    }
    return { maps, detectedComplete };
  }

  async get(id: string): Promise<FlowMap> {
    return this.build(await this.source(id));
  }

  /** What a map is made of (no Redis counts): the table rows, or the detected component. */
  private async source(id: string): Promise<MapSource> {
    if (isDetectedMapId(id)) return this.detectedSource(id);
    const row = await this.getRow(id);
    const nodes = await this.db.select().from(flowMapNodes).where(eq(flowMapNodes.mapId, id));
    const manualEdges = await this.db.select().from(flowMapEdges).where(eq(flowMapEdges.mapId, id));
    nodes.sort((a, b) => a.connectionId.localeCompare(b.connectionId) || a.queueName.localeCompare(b.queueName));
    manualEdges.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return {
      summary: manualSummary(row),
      nodes: nodes.map((n) => ({ connectionId: n.connectionId, queueName: n.queueName, x: n.x ?? null, y: n.y ?? null })),
      manualEdges,
    };
  }

  private async detectedSource(id: string): Promise<MapSource> {
    const ref = parseNodeId(id.slice(DETECTED_MAP_PREFIX.length));
    if (!ref) throw notFound("Flow map");
    const row = await this.connections.getRow(ref.connectionId);
    let edges: FlowEdge[];
    try {
      edges = await this.flows.detectedEdges(row);
    } catch {
      // Down connection: the map cannot be known right now, so it does not exist (the list says the same).
      throw notFound("Flow map");
    }
    const components = detectedComponents(edges);
    const position = components.findIndex((c) => c.root === ref.queueName);
    const component = components[position];
    if (!component) throw notFound("Flow map");
    return {
      summary: { id, kind: "detected", name: component.root, description: null, parentId: null, position, connectionId: row.id },
      nodes: component.queues.map((queueName) => ({ connectionId: row.id, queueName, x: null, y: null })),
      manualEdges: [],
      detectedEdges: component.edges,
    };
  }

  /**
   * Live counts + detected edges for a map's nodes: per connection, one
   * getQueueStats for only the queues on the map. Anything that cannot be read
   * (connection deleted or down, queue not discovered) is a `missing` node,
   * never an error: a map is a drawing first.
   */
  private async build(src: MapSource): Promise<FlowMap> {
    const byConnection = new Map<string, NodeSpec[]>();
    for (const n of src.nodes) {
      const list = byConnection.get(n.connectionId) ?? [];
      list.push(n);
      byConnection.set(n.connectionId, list);
    }
    const rows = new Map((await this.connections.listRows()).map((r) => [r.id, r] as const));

    const live = new Map<string, Omit<FlowMapNode, "id" | "connectionId" | "queueName" | "x" | "y">>();
    const detectedEdges: FlowMapEdge[] = [];
    await Promise.all(
      [...byConnection.entries()].map(async ([connectionId, nodes]) => {
        const row = rows.get(connectionId);
        if (!row) return;
        await Promise.all([this.readCounts(row, nodes, live), this.readDetected(row, src, detectedEdges)]);
      }),
    );

    const nodes: FlowMapNode[] = src.nodes.map((n) => {
      const id = flowMapNodeId(n);
      return {
        id,
        connectionId: n.connectionId,
        queueName: n.queueName,
        x: n.x,
        y: n.y,
        ...(live.get(id) ?? {
          connectionName: rows.get(n.connectionId)?.name ?? n.connectionId,
          counts: { ...EMPTY_COUNTS },
          isPaused: false,
          missing: true,
        }),
      };
    });

    // Detected edges only between queues that are on the map; a manual edge
    // drawn over a detected one is shown once, as the manual one (it has the label).
    const onMap = new Set(nodes.map((n) => n.id));
    const manual = src.manualEdges.map(toManualMapEdge);
    const drawn = new Set(manual.map((e) => `${e.from}->${e.to}`));
    const edges = [
      ...manual,
      ...detectedEdges.filter((e) => onMap.has(e.from) && onMap.has(e.to) && !drawn.has(`${e.from}->${e.to}`)),
    ];
    return { ...src.summary, nodeCount: nodes.length, edgeCount: edges.length, nodes, edges };
  }

  private async readCounts(row: ConnectionRow, nodes: NodeSpec[], live: Map<string, Omit<FlowMapNode, "id" | "connectionId" | "queueName" | "x" | "y">>) {
    try {
      const inspector = this.connections.inspectorFor(row);
      const discovered = new Set(await withRedis(() => inspector.discoverQueues()));
      const present = [...new Set(nodes.map((n) => n.queueName))].filter((q) => discovered.has(q));
      if (present.length === 0) return;
      // The one stats round trip for this connection on this read.
      const stats = await withRedis(() => inspector.getQueueStats(present));
      for (const q of present) {
        const s = stats[q];
        if (!s) continue;
        live.set(flowMapNodeId({ connectionId: row.id, queueName: q }), {
          connectionName: row.name,
          counts: s.counts,
          isPaused: s.isPaused,
          missing: false,
        });
      }
    } catch {
      // down: every node of this connection stays `missing`
    }
  }

  private async readDetected(row: ConnectionRow, src: MapSource, out: FlowMapEdge[]): Promise<void> {
    if (src.detectedEdges) {
      // a detected map lives on one connection and already holds its edges
      if (src.summary.connectionId === row.id) out.push(...src.detectedEdges.map((e) => toDetectedMapEdge(row.id, e)));
      return;
    }
    try {
      const edges = await within(this.flows.detectedEdges(row), DETECTED_WAIT_MS);
      out.push(...edges.map((e) => toDetectedMapEdge(row.id, e)));
    } catch {
      // down or still sampling: the map is drawn with its manual edges only
    }
  }

  // ---------------------------------------------------------------------------
  // writes (manual maps only, except copy)
  // ---------------------------------------------------------------------------

  private async getRow(id: string): Promise<FlowMapRow> {
    const rows = await this.db.select().from(flowMaps).where(eq(flowMaps.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("Flow map");
    return row;
  }

  /** The row of a map a write may touch: 409 for a detected id, 404 for an unknown one. */
  private async writable(id: string): Promise<FlowMapRow> {
    if (isDetectedMapId(id)) throw detectedMapReadOnly();
    return this.getRow(id);
  }

  private async touch(id: string): Promise<void> {
    await this.db.update(flowMaps).set({ updatedAt: new Date() }).where(eq(flowMaps.id, id));
  }

  /** New maps go to the bottom of their level. */
  private async nextPosition(parentId: string | null): Promise<number> {
    const siblings = await this.db
      .select({ id: flowMaps.id })
      .from(flowMaps)
      .where(parentId ? eq(flowMaps.parentId, parentId) : isNull(flowMaps.parentId));
    return siblings.length;
  }

  private async insertMap(input: { name: string; description?: string | null; parentId?: string | null }): Promise<string> {
    const parentId = input.parentId ?? null;
    if (parentId) await this.getRow(parentId);
    const id = nanoid();
    const now = new Date();
    await this.db.insert(flowMaps).values({
      id,
      name: input.name,
      description: input.description ?? null,
      parentId,
      position: await this.nextPosition(parentId),
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async create(input: CreateFlowMapInput): Promise<FlowMap> {
    return this.get(await this.insertMap(input));
  }

  async update(id: string, input: UpdateFlowMapInput): Promise<FlowMap> {
    await this.writable(id);
    if (input.parentId) await this.assertNoCycle(id, input.parentId);
    const patch: Partial<typeof flowMaps.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.parentId !== undefined) patch.parentId = input.parentId;
    if (input.position !== undefined) patch.position = input.position;
    await this.db.update(flowMaps).set(patch).where(eq(flowMaps.id, id));
    return this.get(id);
  }

  /** Moving `id` under `parentId` must not put it under itself or one of its descendants. */
  private async assertNoCycle(id: string, parentId: string): Promise<void> {
    if (isDetectedMapId(parentId)) throw notFound("Flow map");
    const all = await this.db.select({ id: flowMaps.id, parentId: flowMaps.parentId }).from(flowMaps);
    const parentOf = new Map(all.map((r) => [r.id, r.parentId ?? null] as const));
    if (!parentOf.has(parentId)) throw notFound("Flow map");
    // Walk up from the new parent; bounded by the map count so a corrupt loop cannot spin.
    let cursor: string | null = parentId;
    for (let steps = 0; cursor !== null && steps <= all.length; steps++) {
      if (cursor === id) throw conflict("A flow map cannot be moved under itself or one of its own maps");
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  async remove(id: string): Promise<void> {
    const row = await this.writable(id);
    await this.db.transaction(async (tx) => {
      // Children move up one level rather than disappearing (like folders).
      await tx.update(flowMaps).set({ parentId: row.parentId ?? null, updatedAt: new Date() }).where(eq(flowMaps.parentId, id));
      await tx.delete(flowMapEdges).where(eq(flowMapEdges.mapId, id));
      await tx.delete(flowMapNodes).where(eq(flowMapNodes.mapId, id));
      await tx.delete(flowMaps).where(eq(flowMaps.id, id));
    });
  }

  private async findNode(mapId: string, ref: FlowMapNodeRef) {
    const rows = await this.db
      .select()
      .from(flowMapNodes)
      .where(and(eq(flowMapNodes.mapId, mapId), eq(flowMapNodes.connectionId, ref.connectionId), eq(flowMapNodes.queueName, ref.queueName)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Puts a queue on the map if it is not there yet. Returns true when it was added. */
  private async ensureNode(mapId: string, ref: FlowMapNodeRef, pos: { x?: number | null; y?: number | null } = {}): Promise<boolean> {
    if (await this.findNode(mapId, ref)) return false;
    await this.db.insert(flowMapNodes).values({
      mapId,
      connectionId: ref.connectionId,
      queueName: ref.queueName,
      x: pos.x ?? null,
      y: pos.y ?? null,
    });
    return true;
  }

  async addNode(id: string, input: AddFlowMapNodeInput): Promise<FlowMap> {
    await this.writable(id);
    await this.connections.getRow(input.connectionId);
    const added = await this.ensureNode(id, input, input);
    if (!added && (input.x !== undefined || input.y !== undefined)) {
      const patch: { x?: number | null; y?: number | null } = {};
      if (input.x !== undefined) patch.x = input.x;
      if (input.y !== undefined) patch.y = input.y;
      await this.db
        .update(flowMapNodes)
        .set(patch)
        .where(and(eq(flowMapNodes.mapId, id), eq(flowMapNodes.connectionId, input.connectionId), eq(flowMapNodes.queueName, input.queueName)));
    }
    await this.touch(id);
    return this.get(id);
  }

  async removeNode(id: string, nodeId: string): Promise<FlowMap> {
    await this.writable(id);
    const ref = parseNodeId(nodeId);
    if (!ref || !(await this.findNode(id, ref))) throw notFound("Queue on this flow map");
    await this.db.transaction(async (tx) => {
      await tx
        .delete(flowMapEdges)
        .where(
          and(
            eq(flowMapEdges.mapId, id),
            or(
              and(eq(flowMapEdges.fromConnectionId, ref.connectionId), eq(flowMapEdges.fromQueue, ref.queueName)),
              and(eq(flowMapEdges.toConnectionId, ref.connectionId), eq(flowMapEdges.toQueue, ref.queueName)),
            ),
          ),
        );
      await tx
        .delete(flowMapNodes)
        .where(and(eq(flowMapNodes.mapId, id), eq(flowMapNodes.connectionId, ref.connectionId), eq(flowMapNodes.queueName, ref.queueName)));
    });
    await this.touch(id);
    return this.get(id);
  }

  async saveLayout(id: string, input: SaveFlowMapLayoutInput): Promise<void> {
    await this.writable(id);
    const known = new Set(
      (await this.db.select({ connectionId: flowMapNodes.connectionId, queueName: flowMapNodes.queueName }).from(flowMapNodes).where(eq(flowMapNodes.mapId, id))).map(
        (n) => flowMapNodeId(n),
      ),
    );
    // Last write wins per node; unknown ids (a queue removed meanwhile in another tab) are ignored.
    const positions = new Map<string, { x: number; y: number }>();
    for (const p of input.positions) if (known.has(p.nodeId)) positions.set(p.nodeId, { x: p.x, y: p.y });
    await this.db.transaction(async (tx) => {
      for (const [nodeId, pos] of positions) {
        const ref = parseNodeId(nodeId) as FlowMapNodeRef;
        await tx
          .update(flowMapNodes)
          .set(pos)
          .where(and(eq(flowMapNodes.mapId, id), eq(flowMapNodes.connectionId, ref.connectionId), eq(flowMapNodes.queueName, ref.queueName)));
      }
      await tx.update(flowMaps).set({ updatedAt: new Date() }).where(eq(flowMaps.id, id));
    });
  }

  private async findEdge(mapId: string, from: FlowMapNodeRef, to: FlowMapNodeRef) {
    const rows = await this.db
      .select()
      .from(flowMapEdges)
      .where(
        and(
          eq(flowMapEdges.mapId, mapId),
          eq(flowMapEdges.fromConnectionId, from.connectionId),
          eq(flowMapEdges.fromQueue, from.queueName),
          eq(flowMapEdges.toConnectionId, to.connectionId),
          eq(flowMapEdges.toQueue, to.queueName),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Idempotent on the full (from, to) refs, connection included: the same queue
   * name on two connections is two different nodes, and an edge may go from one
   * connection to another (Redis → Postgres included).
   */
  async addEdge(id: string, input: CreateFlowMapEdgeInput): Promise<FlowMap> {
    await this.writable(id);
    if (sameRef(input.from, input.to)) throw conflict("A queue cannot flow into itself");
    await this.connections.getRow(input.from.connectionId);
    if (input.to.connectionId !== input.from.connectionId) await this.connections.getRow(input.to.connectionId);

    await this.ensureNode(id, input.from);
    await this.ensureNode(id, input.to);
    const existing = await this.findEdge(id, input.from, input.to);
    if (existing) {
      if (input.label !== undefined) await this.db.update(flowMapEdges).set({ label: input.label }).where(eq(flowMapEdges.id, existing.id));
    } else {
      await this.db.insert(flowMapEdges).values({
        id: nanoid(),
        mapId: id,
        fromConnectionId: input.from.connectionId,
        fromQueue: input.from.queueName,
        toConnectionId: input.to.connectionId,
        toQueue: input.to.queueName,
        label: input.label ?? null,
        createdAt: new Date(),
      });
    }
    await this.touch(id);
    return this.get(id);
  }

  private async edgeOf(mapId: string, edgeId: string): Promise<FlowMapEdgeRow> {
    const rows = await this.db
      .select()
      .from(flowMapEdges)
      .where(and(eq(flowMapEdges.mapId, mapId), eq(flowMapEdges.id, edgeId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Flow map edge");
    return row;
  }

  async updateEdge(id: string, edgeId: string, input: { label: string | null }): Promise<FlowMap> {
    await this.writable(id);
    await this.edgeOf(id, edgeId);
    await this.db.update(flowMapEdges).set({ label: input.label }).where(eq(flowMapEdges.id, edgeId));
    await this.touch(id);
    return this.get(id);
  }

  async removeEdge(id: string, edgeId: string): Promise<FlowMap> {
    await this.writable(id);
    await this.edgeOf(id, edgeId);
    await this.db.delete(flowMapEdges).where(eq(flowMapEdges.id, edgeId));
    await this.touch(id);
    return this.get(id);
  }

  /**
   * A new manual map with the same queues and positions. Works on detected maps
   * too (that is how one becomes editable). A manual map's drawn edges come
   * along; detected edges are not turned into manual ones, they keep being drawn
   * from the live sample.
   */
  async copy(id: string, input: { name?: string; parentId?: string | null }): Promise<FlowMap> {
    const src = await this.source(id);
    const name = input.name ?? `${src.summary.name} (copy)`.slice(0, NAME_MAX);
    const newId = await this.insertMap({ name, description: src.summary.description, parentId: input.parentId ?? null });
    await this.db.transaction(async (tx) => {
      if (src.nodes.length > 0) {
        await tx.insert(flowMapNodes).values(src.nodes.map((n) => ({ mapId: newId, connectionId: n.connectionId, queueName: n.queueName, x: n.x, y: n.y })));
      }
      if (src.manualEdges.length > 0) {
        const now = new Date();
        await tx.insert(flowMapEdges).values(
          src.manualEdges.map((e) => ({
            id: nanoid(),
            mapId: newId,
            fromConnectionId: e.fromConnectionId,
            fromQueue: e.fromQueue,
            toConnectionId: e.toConnectionId,
            toQueue: e.toQueue,
            label: e.label ?? null,
            createdAt: now,
          })),
        );
      }
    });
    return this.get(newId);
  }
}
