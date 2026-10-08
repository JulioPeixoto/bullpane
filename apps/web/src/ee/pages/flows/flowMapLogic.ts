/**
 * Pure logic behind the flow maps page: the map tree, the "Move to…" options
 * and the incremental layout of queues that were never placed. Kept free of
 * React so it can be tested on its own.
 */
import type { FlowMapSummary } from "@bullpane/shared";
import { layoutGraph, type LayoutEdge } from "@/lib/flowLayout";

// ---------------------------------------------------------------------------
// Map tree
// ---------------------------------------------------------------------------

export interface MapTreeNode {
  map: FlowMapSummary;
  depth: number;
  children: MapTreeNode[];
}

const byPosition = (a: FlowMapSummary, b: FlowMapSummary) =>
  a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Manual maps as a tree (`parentId`, then `position`). A map whose parent is
 * missing from the list is shown at the root rather than dropped, and a
 * parent cycle (which the server forbids, but a stale list could show) is cut
 * so the tree always terminates.
 */
export function buildMapTree(maps: FlowMapSummary[]): MapTreeNode[] {
  const manual = maps.filter((m) => m.kind === "manual");
  const ids = new Set(manual.map((m) => m.id));
  const children = new Map<string | null, FlowMapSummary[]>();
  for (const m of manual) {
    const parent = m.parentId && ids.has(m.parentId) && m.parentId !== m.id ? m.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(m);
  }
  const seen = new Set<string>();
  const build = (parent: string | null, depth: number): MapTreeNode[] =>
    (children.get(parent) ?? [])
      .slice()
      .sort(byPosition)
      .filter((m) => !seen.has(m.id))
      .map((m) => {
        seen.add(m.id);
        return { map: m, depth, children: build(m.id, depth + 1) };
      });
  const roots = build(null, 0);
  // Members of a parent cycle are unreachable from the root: surface them there.
  for (const m of manual.slice().sort(byPosition)) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      roots.push({ map: m, depth: 0, children: build(m.id, 1) });
    }
  }
  return roots;
}

/** Depth-first, honouring collapsed nodes: what the sidebar renders, in order. */
export function flattenTree(roots: MapTreeNode[], collapsed: ReadonlySet<string> = new Set()): MapTreeNode[] {
  const out: MapTreeNode[] = [];
  const walk = (nodes: MapTreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (!collapsed.has(n.map.id)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** The chain of ancestors of `id`, root first, excluding the map itself. */
export function ancestorsOf(maps: FlowMapSummary[], id: string): FlowMapSummary[] {
  const byId = new Map(maps.map((m) => [m.id, m]));
  const out: FlowMapSummary[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id)?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    const m = byId.get(cur);
    if (!m) break;
    out.unshift(m);
    seen.add(cur);
    cur = m.parentId;
  }
  return out;
}

export interface MoveTarget {
  /** null = the top level */
  id: string | null;
  label: string;
  depth: number;
}

/**
 * Where a map may be moved: the top level, or any manual map that is neither
 * the map itself nor one of its descendants (the server answers 409 to those).
 * Its current parent is included so the picker can show the current choice.
 */
export function moveTargets(maps: FlowMapSummary[], id: string): MoveTarget[] {
  const tree = buildMapTree(maps);
  const out: MoveTarget[] = [{ id: null, label: "Top level", depth: 0 }];
  const walk = (nodes: MapTreeNode[]) => {
    for (const n of nodes) {
      if (n.map.id === id) continue; // skips the whole subtree
      out.push({ id: n.map.id, label: n.map.name, depth: n.depth + 1 });
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** Detected maps grouped by the connection they come from, in connection order. */
export function groupDetected(
  maps: FlowMapSummary[],
  connectionOrder: string[],
): { connectionId: string; maps: FlowMapSummary[] }[] {
  const groups = new Map<string, FlowMapSummary[]>();
  for (const m of maps) {
    if (m.kind !== "detected" || !m.connectionId) continue;
    if (!groups.has(m.connectionId)) groups.set(m.connectionId, []);
    groups.get(m.connectionId)!.push(m);
  }
  const rank = (cid: string) => {
    const i = connectionOrder.indexOf(cid);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([connectionId, list]) => ({ connectionId, maps: list.slice().sort((a, b) => a.name.localeCompare(b.name)) }));
}

// ---------------------------------------------------------------------------
// Incremental layout
// ---------------------------------------------------------------------------

export interface PlacementNode {
  id: string;
  x: number | null;
  y: number | null;
}

export interface PlacementOptions {
  nodeWidth: number;
  nodeHeight: number;
  columnGap?: number;
  rowGap?: number;
}

type Pos = { x: number; y: number };

/**
 * Positions for the nodes that have none (x/y = null), without touching the
 * ones that do, so a queue added by someone else (or by an MCP client) lands
 * next to the queues it is wired to instead of reshuffling the whole map.
 *
 * - Nothing placed yet: the whole map gets the layered left-to-right layout.
 * - A node with placed predecessors goes one column to their right, at their
 *   average height; with only placed successors, one column to their left.
 *   Newly placed nodes count as placed, so a new chain grows link by link.
 * - It then slides down a row at a time until it overlaps nothing.
 * - Whatever is left (not wired to anything placed) is laid out on its own
 *   and parked under the existing drawing.
 *
 * Returns positions for the unplaced nodes only.
 */
export function placeUnplaced(
  nodes: PlacementNode[],
  edges: LayoutEdge[],
  opts: PlacementOptions,
): Map<string, Pos> {
  const { nodeWidth: w, nodeHeight: h, columnGap = 90, rowGap = 28 } = opts;
  const result = new Map<string, Pos>();
  const placed = new Map<string, Pos>();
  for (const n of nodes) if (n.x != null && n.y != null) placed.set(n.id, { x: n.x, y: n.y });
  const pending = nodes.filter((n) => !placed.has(n.id)).map((n) => n.id);
  if (pending.length === 0) return result;

  const layoutOpts = { nodeWidth: w, nodeHeight: h, columnGap, rowGap };
  if (placed.size === 0) {
    const all = layoutGraph(nodes.map((n) => ({ id: n.id })), edges, layoutOpts);
    for (const id of pending) {
      const p = all.get(id)!;
      result.set(id, { x: p.x, y: p.y });
    }
    return result;
  }

  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const id of ids) {
    preds.set(id, []);
    succs.set(id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    succs.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
  }

  const overlaps = (p: Pos) => {
    for (const q of placed.values()) {
      if (Math.abs(q.x - p.x) < w + 10 && Math.abs(q.y - p.y) < h + rowGap / 2) return true;
    }
    return false;
  };
  const freeSpot = (p: Pos): Pos => {
    let cur = { ...p };
    for (let i = 0; i < 500 && overlaps(cur); i++) cur = { x: cur.x, y: cur.y + h + rowGap };
    return cur;
  };
  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

  let remaining = pending.slice().sort();
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    const next: string[] = [];
    for (const id of remaining) {
      const placedPreds = preds.get(id)!.filter((p) => placed.has(p)).map((p) => placed.get(p)!);
      const placedSuccs = succs.get(id)!.filter((s) => placed.has(s)).map((s) => placed.get(s)!);
      let target: Pos | null = null;
      if (placedPreds.length) {
        target = { x: Math.max(...placedPreds.map((p) => p.x)) + w + columnGap, y: avg(placedPreds.map((p) => p.y)) };
      } else if (placedSuccs.length) {
        target = { x: Math.min(...placedSuccs.map((p) => p.x)) - w - columnGap, y: avg(placedSuccs.map((p) => p.y)) };
      }
      if (!target) {
        next.push(id);
        continue;
      }
      const spot = freeSpot(target);
      placed.set(id, spot);
      result.set(id, spot);
      progress = true;
    }
    remaining = next;
  }

  if (remaining.length) {
    // Islands: lay them out together and park the block under the drawing.
    const rest = new Set(remaining);
    const island = layoutGraph(
      remaining.map((id) => ({ id })),
      edges.filter((e) => rest.has(e.from) && rest.has(e.to)),
      layoutOpts,
    );
    const xs = [...placed.values()].map((p) => p.x);
    const ys = [...placed.values()].map((p) => p.y);
    const originX = Math.min(...xs);
    const originY = Math.max(...ys) + h + rowGap * 2;
    for (const id of remaining) {
      const p = island.get(id)!;
      const spot = freeSpot({ x: originX + p.x, y: originY + p.y });
      placed.set(id, spot);
      result.set(id, spot);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Connections on a map
// ---------------------------------------------------------------------------

/** Avoids the accent blue (drawn arrows), the teal (detected arrows) and, first, the job-state colours on the same card. */
export const CONNECTION_COLORS = ["#f778ba", "#ff8c42", "#a5d64c", "#79c0ff", "#d2a8ff", "#e3b341", "#56d4a8", "#ff7b72"];

export interface MapConnection {
  connectionId: string;
  name: string;
  color: string;
  /** queues of this connection on the map */
  count: number;
}

/**
 * A connection's colour, the same on every map and in every picker: it is
 * picked by the connection's place in the installation's connection list, so
 * adding a queue from a new connection to a map never repaints the others.
 * Unknown connections (deleted, not loaded yet) hash to a stable colour.
 */
export function connectionColor(connectionId: string, connectionOrder: { id: string }[]): string {
  const i = connectionOrder.findIndex((c) => c.id === connectionId);
  if (i !== -1) return CONNECTION_COLORS[i % CONNECTION_COLORS.length];
  let h = 0;
  for (const ch of connectionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CONNECTION_COLORS[h % CONNECTION_COLORS.length];
}

export interface MapConnection {
  connectionId: string;
  name: string;
  color: string;
  /** queues of this connection on the map */
  count: number;
}

/**
 * The connections a map spans (for the legend and the node chips), in the
 * installation's connection order. A queue name on two connections is two
 * nodes, counted on each side.
 */
export function mapConnections(
  nodes: { connectionId: string; connectionName?: string }[],
  connectionOrder: { id: string; name: string }[] = [],
): MapConnection[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const n of nodes) {
    const cur = counts.get(n.connectionId);
    if (cur) cur.count++;
    else counts.set(n.connectionId, { name: n.connectionName || n.connectionId, count: 1 });
  }
  const rank = (cid: string) => {
    const i = connectionOrder.findIndex((c) => c.id === cid);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...counts.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([connectionId, v]) => ({
      connectionId,
      name: connectionOrder.find((c) => c.id === connectionId)?.name ?? v.name,
      color: connectionColor(connectionId, connectionOrder),
      count: v.count,
    }));
}

/** Node ids are `${connectionId}:${queueName}`; connection ids never contain ":", queue names may. */
export function parseNodeId(id: string): { connectionId: string; queueName: string } | null {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) return null;
  return { connectionId: id.slice(0, i), queueName: id.slice(i + 1) };
}
