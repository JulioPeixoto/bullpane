/**
 * Node and edge renderers shared by the flow map canvas and the
 * whole-connection graph, so both read as the same picture.
 */
import { createContext, memo, useContext, useEffect, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { ArrowRight, Database, ExternalLink, SearchX } from "lucide-react";
import type { QueueCounts } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatCompact, formatNumber } from "@/lib/format";
import { STATE_COLORS } from "@/lib/stateColors";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";

export const NODE_W = 232;
export const NODE_H = 92;
/** room between columns for an edge label */
export const COLUMN_GAP = 140;
export const LAYOUT = { nodeWidth: NODE_W, nodeHeight: NODE_H, columnGap: COLUMN_GAP, rowGap: 28 };

// ---------------------------------------------------------------------------
// Queue node
// ---------------------------------------------------------------------------

export interface QueueNodeData extends Record<string, unknown> {
  queueName: string;
  connectionId: string;
  /** shown only when the map spans several connections, as a chip in the connection's colour */
  connectionName: string | null;
  connectionColor: string | null;
  counts: QueueCounts;
  isPaused: boolean;
  missing: boolean;
  /** arrived after the canvas first rendered: one soft highlight */
  fresh?: boolean;
}
export type QueueNode = Node<QueueNodeData, "queue">;

export const QueueNodeView = memo(function QueueNodeView({ data, selected, isConnectable }: NodeProps<QueueNode>) {
  const c = data.counts;
  const state = data.missing ? "missing" : c.failed > 0 ? "failed" : c.active > 0 ? "active" : c.waiting + c.prioritized > 0 ? "waiting" : "idle";
  const dot = {
    missing: "bg-fg-subtle",
    failed: STATE_COLORS.failed.dotClass,
    active: STATE_COLORS.active.dotClass,
    waiting: STATE_COLORS.waiting.dotClass,
    idle: "bg-border-strong",
  }[state];
  return (
    <div
      className={cn(
        "fm-node relative flex flex-col rounded-lg border bg-surface px-3 py-2 text-fg shadow-sm",
        data.fresh && "fm-fresh",
        selected ? "border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_25%,transparent)]" : "border-border-strong hover:border-fg-subtle",
        data.isPaused && !selected && "border-dashed",
        data.missing && "border-dashed opacity-60",
      )}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle type="target" position={Position.Left} className="fm-handle" isConnectable={isConnectable} />
      <div className="flex min-w-0 items-center gap-1.5 pr-5">
        <span className={cn("status-dot size-2", dot, state === "active" && "pulse text-state-active")} aria-hidden />
        <span className="truncate text-[13px] font-semibold" title={data.queueName}>
          {data.queueName}
        </span>
        {data.isPaused && !data.missing && (
          <Badge variant="warning" size="xs" className="ml-auto">
            paused
          </Badge>
        )}
      </div>
      {data.connectionName && (
        <span className="mt-1 flex min-w-0">
          <ConnectionChip name={data.connectionName} color={data.connectionColor} />
        </span>
      )}
      {data.missing ? (
        <div className="mt-auto flex items-center gap-1.5 text-[11px] text-fg-muted">
          <SearchX className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">Queue not found on this connection</span>
        </div>
      ) : (
        <div className="mt-auto grid grid-cols-4 gap-1 text-[11px]">
          <Count label="waiting" value={c.waiting + c.prioritized} tone={STATE_COLORS.waiting.textClass} />
          <Count label="active" value={c.active} tone={STATE_COLORS.active.textClass} />
          <Count label="delayed" value={c.delayed} tone={STATE_COLORS.delayed.textClass} />
          <Count label="failed" value={c.failed} tone={STATE_COLORS.failed.textClass} />
        </div>
      )}
      {!data.missing && (
        <Link
          to={routes.queue(data.connectionId, data.queueName)}
          className="nodrag absolute top-1.5 right-1.5 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          title="Open queue"
          aria-label={`Open queue ${data.queueName}`}
        >
          <ExternalLink className="size-3" />
        </Link>
      )}
      <Handle type="source" position={Position.Right} className="fm-handle" isConnectable={isConnectable} />
    </div>
  );
});

/** A connection's name in its map colour. Same chip on nodes, edges and the legend. */
export function ConnectionChip({ name, color, className }: { name: string; color: string | null; className?: string }) {
  const c = color ?? "var(--fg-subtle)";
  return (
    <span
      className={cn("inline-flex h-4 min-w-0 items-center gap-1 rounded px-1 text-[10px] leading-none font-medium", className)}
      style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 38%, transparent)` }}
      title={`Connection: ${name}`}
    >
      <Database className="size-2.5 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className={cn("num font-semibold", value > 0 ? tone : "text-fg-subtle")}>{formatCompact(value)}</span>
      <span className="text-[10px] text-fg-subtle">{label}</span>
    </span>
  );
}

export const nodeTypes: NodeTypes = { queue: QueueNodeView };

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

export interface FlowEdgeData extends Record<string, unknown> {
  source: "manual" | "detected";
  label: string | null;
  evidence: number;
  /** set when the two ends live on different connections (one Redis to another, Redis to Postgres) */
  cross: { from: { name: string; color: string | null }; to: { name: string; color: string | null } } | null;
}
export type FlowEdgeT = Edge<FlowEdgeData, "flow">;

/** Label clicks live outside the edge's SVG, so they reach the canvas through here. */
export const EdgeLabelClickContext = createContext<((edgeId: string, e: MouseEvent) => void) | null>(null);

const EDGE_COLOR = { manual: "var(--fm-edge-manual)", detected: "var(--fm-edge-detected)" } as const;

/**
 * The arrowhead, drawn as a path at the target end instead of an SVG marker:
 * React Flow derives a marker's id from its color, and a `var(--…)` color
 * makes an id that `url(#…)` cannot reference, so no arrowhead showed at all.
 * The tip sits on the target node's border (see FlowEdgeView), not on
 * React Flow's handle point, which lands inside the node, under it.
 */
function arrowHead(x: number, y: number, side: Position, size: number): string {
  const s = size;
  const h = s * 0.6;
  switch (side) {
    case Position.Left:
      return `M${x - s},${y - h} L${x},${y} L${x - s},${y + h} Z`;
    case Position.Right:
      return `M${x + s},${y - h} L${x},${y} L${x + s},${y + h} Z`;
    case Position.Top:
      return `M${x - h},${y - s} L${x},${y} L${x + h},${y - s} Z`;
    default:
      return `M${x - h},${y + s} L${x},${y} L${x + h},${y + s} Z`;
  }
}

export function toFlowEdge(
  e: { id: string; from: string; to: string; source: "manual" | "detected"; label: string | null; evidence: number },
  cross: FlowEdgeData["cross"] = null,
): FlowEdgeT {
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    type: "flow",
    data: { source: e.source, label: e.label, evidence: e.evidence, cross },
    // React Flow's own keyboard deletion is routed through onBeforeDelete; detected edges never delete.
    deletable: e.source === "manual",
  };
}

/** half of `.fm-handle`'s 10px */
const HANDLE_R = 5;

export const FlowEdgeView = memo(function FlowEdgeView(props: EdgeProps<FlowEdgeT>) {
  const { id, sourceX, sourceY, targetX: handleX, targetY, sourcePosition, targetPosition, selected, data } = props;
  const onLabelClick = useContext(EdgeLabelClickContext);
  // Tip just outside the handle dot centered on the node's border (flows.css:
  // 10px handles). The handle point React Flow hands us sits inside the node,
  // where the node would cover the arrowhead.
  const targetNode = useInternalNode(props.target);
  const tipX =
    targetNode && targetPosition === Position.Left
      ? targetNode.internals.positionAbsolute.x - HANDLE_R
      : targetNode && targetPosition === Position.Right
        ? targetNode.internals.positionAbsolute.x + (targetNode.measured.width ?? 0) + HANDLE_R
        : handleX;
  const head = selected ? 11 : 9;
  const targetX = targetPosition === Position.Left ? tipX - head : targetPosition === Position.Right ? tipX + head : tipX;
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  // Draw once on mount; the arrowhead and the flowing dashes come after.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setDrawn(true), 680);
    return () => window.clearTimeout(t);
  }, []);
  const source = data?.source ?? "manual";
  const detected = source === "detected";
  const color = EDGE_COLOR[source];
  const label = data?.label ?? null;
  const evidence = data?.evidence ?? 0;
  const cross = data?.cross ?? null;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={22}
        className={cn(!drawn ? "fm-edge-draw" : detected && "fm-edge-flow")}
        // pathLength normalises the draw-in dash to 0..1; it would also rescale the flow dashes, so it goes once drawn.
        {...(!drawn ? { pathLength: 1 } : {})}
        style={{ stroke: color, strokeWidth: selected ? 2.5 : detected ? 1.5 : 1.75, opacity: selected ? 1 : 0.9 }}
      />
      {drawn && <path d={arrowHead(tipX, targetY, targetPosition, head)} className="fm-arrowhead" style={{ fill: color }} />}
      {(label || detected || cross) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute"
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            <div className="fm-edge-label">
              <Tooltip
                content={
                  detected
                    ? `From BullMQ FlowProducer: ${formatNumber(evidence)} sampled ${evidence === 1 ? "job" : "jobs"} carry this parent link`
                    : cross
                      ? `Crosses connections: ${cross.from.name} → ${cross.to.name}`
                      : undefined
                }
              >
                <button
                  type="button"
                  onClick={(e) => onLabelClick?.(id, e)}
                  className={cn(
                    "flex max-w-56 items-center gap-1 rounded-md border bg-surface px-1.5 py-0.5 text-[11px] leading-tight shadow-sm transition-colors",
                    selected ? "border-accent text-fg" : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
                  )}
                >
                  {cross && (
                    <span className="flex shrink-0 items-center gap-0.5" aria-label={`from ${cross.from.name} to ${cross.to.name}`}>
                      <span className="size-1.5 rounded-full" style={{ background: cross.from.color ?? "var(--fg-subtle)" }} />
                      <ArrowRight className="size-2.5 text-fg-subtle" aria-hidden />
                      <span className="size-1.5 rounded-full" style={{ background: cross.to.color ?? "var(--fg-subtle)" }} />
                    </span>
                  )}
                  {detected && <span className="num font-mono text-teal">×{formatCompact(evidence)}</span>}
                  {label && <span className="truncate">{label}</span>}
                </button>
              </Tooltip>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes: EdgeTypes = { flow: FlowEdgeView };

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export function EdgeLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-muted", className)}>
      <span className="flex items-center gap-1.5">
        <svg width="28" height="8" aria-hidden>
          <line x1="0" y1="4" x2="28" y2="4" stroke="var(--accent)" strokeWidth="1.75" />
        </svg>
        drawn
      </span>
      <Tooltip content="From BullMQ FlowProducer: the arrow goes from the parent queue to each child queue it waits for.">
        <span className="flex items-center gap-1.5">
          <svg width="28" height="8" aria-hidden>
            <line x1="0" y1="4" x2="28" y2="4" stroke="var(--teal)" strokeWidth="1.5" strokeDasharray="6 5" />
          </svg>
          detected
        </span>
      </Tooltip>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-5 rounded-sm border border-dashed border-border-strong" aria-hidden />
        paused / not found
      </span>
    </div>
  );
}
