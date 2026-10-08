import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type OnBeforeDelete,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderInput,
  LayoutGrid,
  Link2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type { FlowMap, FlowMapEdge, FlowMapNode, FlowMapNodeRef, FlowMapSummary } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatNumber } from "@/lib/format";
import { layoutGraph } from "@/lib/flowLayout";
import {
  useAddFlowMapNode,
  useConnections,
  useCopyFlowMap,
  useCreateFlowMapEdge,
  useDeleteFlowMap,
  useDeleteFlowMapEdge,
  useFlowMap,
  useRemoveFlowMapNode,
  useSaveFlowMapLayout,
  useUpdateFlowMap,
  useUpdateFlowMapEdge,
} from "@/api/hooks";
import { errorMessage, isApiError } from "@/api/client";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Tooltip } from "@/components/ui/Tooltip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  ConnectionChip,
  EdgeLabelClickContext,
  EdgeLegend,
  LAYOUT,
  NODE_H,
  NODE_W,
  edgeTypes,
  nodeTypes,
  toFlowEdge,
  type FlowEdgeT,
  type QueueNode,
} from "./canvasParts";
import { AddQueuePopover } from "./AddQueuePopover";
import { MoveMapDialog } from "./MapDialogs";
import { ancestorsOf, connectionColor, mapConnections, parseNodeId, placeUnplaced } from "./flowMapLogic";

type Pos = { x: number; y: number };

/** Wait this long after the user's last pan/zoom before the view follows new queues on its own. */
const FOLLOW_AFTER_IDLE_MS = 4_000;
/** A drag not confirmed by the server after this long gives way to the server's position. */
const LOCAL_POSITION_TTL_MS = 15_000;
const SAVE_DEBOUNCE_MS = 400;
const GLIDE_MS = 520;
const FIT_MS = 800;
/** Smallest zoom auto-fit picks (see fitTargets). */
const FIT_MIN_ZOOM = 0.5;
const FRESH_MS = 2_500;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function MapCanvas(props: MapCanvasProps) {
  return (
    <ReactFlowProvider>
      <MapCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

interface MapCanvasProps {
  mapId: string;
  maps: FlowMapSummary[];
  canOperate: boolean;
  onSelectMap: (id: string) => void;
  onDeleted: (parentId: string | null) => void;
}

function MapCanvasInner({ mapId, maps, canOperate, onSelectMap, onDeleted }: MapCanvasProps) {
  const q = useFlowMap(mapId);
  const map = q.data;
  const connections = useConnections();
  const rf = useReactFlow<QueueNode, FlowEdgeT>();
  const container = useRef<HTMLDivElement>(null);

  const detected = map?.kind === "detected" || mapId.startsWith("detected:");
  const canEdit = canOperate && !detected;

  const addNode = useAddFlowMapNode();
  const removeNode = useRemoveFlowMapNode();
  const createEdge = useCreateFlowMapEdge();
  const updateEdge = useUpdateFlowMapEdge();
  const deleteEdge = useDeleteFlowMapEdge();
  const saveLayout = useSaveFlowMapLayout();
  const copyMap = useCopyFlowMap();

  const [nodes, setNodes, onNodesChange] = useNodesState<QueueNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdgeT>([]);
  const [adding, setAdding] = useState(false);
  const [edgePop, setEdgePop] = useState<{ id: string; x: number; y: number } | null>(null);

  // --- position bookkeeping (refs: they change every frame or every poll) ---
  /** where each node should be: server position, else a local drag, else auto-placed */
  const targets = useRef(new Map<string, Pos>());
  /** positions computed here for nodes the server has as unplaced (x/y null) */
  const autoPos = useRef(new Map<string, Pos>());
  /** dragged here and not yet confirmed by the server */
  const localPos = useRef(new Map<string, Pos & { at: number }>());
  const dragging = useRef(new Set<string>());
  const pendingSave = useRef(new Map<string, Pos>());
  const saveTimer = useRef<number>();
  const raf = useRef<number>();
  const firstSeen = useRef(new Map<string, number>());
  const initialised = useRef(false);
  const lastUserMove = useRef(0);

  const connOrder = useMemo(() => (connections.data ?? []).map((c) => ({ id: c.id, name: c.name })), [connections.data]);
  const spans = useMemo(() => (map ? mapConnections(map.nodes, connOrder) : []), [map, connOrder]);
  const multi = spans.length > 1;
  const nodeById = useMemo(() => new Map((map?.nodes ?? []).map((n) => [n.id, n])), [map]);

  /** Tween every non-dragged node from where it is to its target, so edges follow along. */
  const glide = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    const from = new Map(rf.getNodes().map((n) => [n.id, { ...n.position }]));
    const moving = [...targets.current].filter(([id, to]) => {
      const f = from.get(id);
      return f && !dragging.current.has(id) && (Math.abs(f.x - to.x) > 0.5 || Math.abs(f.y - to.y) > 0.5);
    });
    if (moving.length === 0) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    const step = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - start) / GLIDE_MS);
      const k = easeOut(t);
      setNodes((ns) =>
        ns.map((n) => {
          const to = targets.current.get(n.id);
          const f = from.get(n.id);
          if (!to || !f || dragging.current.has(n.id)) return n;
          if (Math.abs(f.x - to.x) <= 0.5 && Math.abs(f.y - to.y) <= 0.5) return n;
          return { ...n, position: { x: f.x + (to.x - f.x) * k, y: f.y + (to.y - f.y) * k } };
        }),
      );
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [rf, setNodes]);

  /** Fit the view to where nodes are going (not where they are mid-glide). */
  const fitTargets = useCallback(
    (duration: number) => {
      const el = container.current;
      const pts = [...targets.current.values()];
      if (!el || pts.length === 0) return;
      const minX = Math.min(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxX = Math.max(...pts.map((p) => p.x + NODE_W));
      const maxY = Math.max(...pts.map((p) => p.y + NODE_H));
      // Auto-fit never shrinks below FIT_MIN_ZOOM: past that, queue names stop being
      // readable, and a long flow that is centred and pannable beats a whole flow
      // nobody can read. Zooming out by hand still goes down to the canvas minimum.
      const vp = getViewportForBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, el.clientWidth, el.clientHeight, FIT_MIN_ZOOM, 1, 0.08);
      void rf.setViewport(vp, { duration });
    },
    [rf],
  );

  // --- server data → canvas -------------------------------------------------
  useEffect(() => {
    if (!map) return;
    const now = Date.now();
    const serverIds = new Set(map.nodes.map((n) => n.id));
    for (const [id, lp] of localPos.current) {
      const n = nodeById.get(id);
      if (!n || (n.x === lp.x && n.y === lp.y) || now - lp.at > LOCAL_POSITION_TTL_MS) localPos.current.delete(id);
    }
    for (const id of autoPos.current.keys()) if (!serverIds.has(id)) autoPos.current.delete(id);

    const base = map.nodes.map((n) => {
      const lp = localPos.current.get(n.id);
      if (lp) return { id: n.id, x: lp.x, y: lp.y };
      if (n.x != null && n.y != null) {
        autoPos.current.delete(n.id);
        return { id: n.id, x: n.x, y: n.y };
      }
      const a = autoPos.current.get(n.id);
      return { id: n.id, x: a?.x ?? null, y: a?.y ?? null };
    });
    const placed = placeUnplaced(base, map.edges, LAYOUT);
    placed.forEach((p, id) => autoPos.current.set(id, p));
    const next = new Map<string, Pos>();
    for (const b of base) next.set(b.id, b.x != null && b.y != null ? { x: b.x, y: b.y } : placed.get(b.id)!);
    targets.current = next;

    const newIds: string[] = [];
    for (const n of map.nodes) {
      if (!firstSeen.current.has(n.id)) {
        firstSeen.current.set(n.id, initialised.current ? now : 0);
        newIds.push(n.id);
      }
    }
    const colorOf = (cid: string) => connectionColor(cid, connOrder);

    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return map.nodes.map((n) => {
        const data = {
          queueName: n.queueName,
          connectionId: n.connectionId,
          connectionName: multi ? n.connectionName : null,
          connectionColor: multi ? colorOf(n.connectionId) : null,
          counts: n.counts,
          isPaused: n.isPaused,
          missing: n.missing,
          fresh: now - (firstSeen.current.get(n.id) ?? 0) < FRESH_MS,
        };
        const p = prevById.get(n.id);
        if (p) return { ...p, data, deletable: canEdit };
        return { id: n.id, type: "queue" as const, position: next.get(n.id)!, data, width: NODE_W, height: NODE_H, deletable: canEdit };
      });
    });
    setEdges((prev) => {
      const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return map.edges.map((e) => {
        const a = nodeById.get(e.from);
        const b = nodeById.get(e.to);
        const cross =
          a && b && a.connectionId !== b.connectionId
            ? { from: { name: a.connectionName, color: colorOf(a.connectionId) }, to: { name: b.connectionName, color: colorOf(b.connectionId) } }
            : null;
        return { ...toFlowEdge(e, cross), selected: sel.has(e.id) };
      });
    });
    requestAnimationFrame(glide);

    if (!initialised.current) {
      initialised.current = true;
      if (map.nodes.length) requestAnimationFrame(() => fitTargets(0));
    } else if (newIds.length && Date.now() - lastUserMove.current > FOLLOW_AFTER_IDLE_MS && dragging.current.size === 0) {
      // New queues arrived (another user, an MCP client): follow them, unless the user is looking around.
      requestAnimationFrame(() => fitTargets(FIT_MS));
    }
  }, [map, nodeById, multi, connOrder, canEdit, setNodes, setEdges, glide, fitTargets]);

  // A live map keeps "fresh" highlights for a moment only; drop them when they are done.
  useEffect(() => {
    if (!nodes.some((n) => n.data.fresh)) return;
    const t = window.setTimeout(() => setNodes((ns) => ns.map((n) => (n.data.fresh ? { ...n, data: { ...n.data, fresh: false } } : n))), FRESH_MS);
    return () => window.clearTimeout(t);
  }, [nodes, setNodes]);

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      window.clearTimeout(saveTimer.current);
    },
    [],
  );

  // --- writes ---------------------------------------------------------------
  const flushSave = useCallback(() => {
    if (!canEdit || !map) return;
    const positions = new Map(pendingSave.current);
    pendingSave.current.clear();
    // Auto-placed queues get saved with the drag so the whole team sees the same drawing.
    for (const n of map.nodes) {
      if (n.x == null && !positions.has(n.id)) {
        const p = targets.current.get(n.id);
        if (p) positions.set(n.id, p);
      }
    }
    if (positions.size === 0) return;
    saveLayout.mutate(
      { mapId, input: { positions: [...positions].map(([nodeId, p]) => ({ nodeId, x: Math.round(p.x), y: Math.round(p.y) })) } },
      { onError: (e) => toast.error(`Could not save the layout: ${errorMessage(e)}`) },
    );
  }, [canEdit, map, mapId, saveLayout]);

  const onDragStop = useCallback(
    (_: unknown, _node: QueueNode, dragged: QueueNode[]) => {
      const at = canEdit ? Date.now() : Number.POSITIVE_INFINITY; // read-only: the local arrangement is the user's own
      for (const n of dragged) {
        dragging.current.delete(n.id);
        localPos.current.set(n.id, { ...n.position, at });
        targets.current.set(n.id, { ...n.position });
        pendingSave.current.set(n.id, { ...n.position });
      }
      if (!canEdit) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    },
    [canEdit, flushSave],
  );

  const relayout = useCallback(() => {
    if (!map) return;
    const pos = layoutGraph(map.nodes.map((n) => ({ id: n.id })), map.edges, LAYOUT);
    const at = canEdit ? Date.now() : Number.POSITIVE_INFINITY;
    autoPos.current.clear();
    pos.forEach((p, id) => {
      targets.current.set(id, { x: p.x, y: p.y });
      localPos.current.set(id, { x: p.x, y: p.y, at });
    });
    glide();
    window.setTimeout(() => fitTargets(FIT_MS), 60);
    if (canEdit) {
      pendingSave.current.clear();
      saveLayout.mutate(
        { mapId, input: { positions: [...pos.values()].map((p) => ({ nodeId: p.id, x: Math.round(p.x), y: Math.round(p.y) })) } },
        { onError: (e) => toast.error(`Could not save the layout: ${errorMessage(e)}`) },
      );
    }
  }, [map, canEdit, glide, fitTargets, saveLayout, mapId]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!canEdit || !c.source || !c.target || c.source === c.target) return;
      // Node ids are `${connectionId}:${queueName}`: never resolve by queue name, the same name may live on two connections.
      const refOf = (id: string): FlowMapNodeRef | null => {
        const n = nodeById.get(id);
        return n ? { connectionId: n.connectionId, queueName: n.queueName } : parseNodeId(id);
      };
      const from = refOf(c.source);
      const to = refOf(c.target);
      if (!from || !to) return;
      // Each end carries its own connection: an arrow may go from one Redis to another, or to Postgres.
      createEdge.mutate({ mapId, input: { from, to } }, { onError: (e) => toast.error(errorMessage(e)) });
    },
    [canEdit, mapId, nodeById, createEdge],
  );

  const onBeforeDelete: OnBeforeDelete<QueueNode, FlowEdgeT> = useCallback(
    async ({ nodes: ns, edges: es }) => {
      if (!canEdit) return false;
      const gone = new Set(ns.map((n) => n.id));
      for (const n of ns) removeNode.mutate({ mapId, nodeId: n.id }, { onError: (e) => toast.error(errorMessage(e)) });
      for (const e of es) {
        if (e.selected && e.data?.source === "manual" && !gone.has(e.source) && !gone.has(e.target)) {
          deleteEdge.mutate({ mapId, edgeId: e.id }, { onError: (err) => toast.error(errorMessage(err)) });
        }
      }
      setEdgePop(null);
      return false; // the server's answer redraws the map
    },
    [canEdit, mapId, removeNode, deleteEdge],
  );

  const openEdgePop = useCallback((edgeId: string, e: ReactMouseEvent) => {
    const r = container.current?.getBoundingClientRect();
    if (!r) return;
    setEdgePop({ id: edgeId, x: e.clientX - r.left, y: e.clientY - r.top });
    setEdges((es) => es.map((x) => ({ ...x, selected: x.id === edgeId })));
  }, [setEdges]);

  // --- render ---------------------------------------------------------------
  if (q.isError && !map) {
    const notFound = isApiError(q.error) && q.error.status === 404;
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<Workflow />}
          title={notFound ? "This map no longer exists" : "Could not load this map"}
          description={notFound ? "Someone deleted it, or the queues behind a detected map stopped linking." : errorMessage(q.error)}
        />
      </div>
    );
  }

  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedNode = selectedNodes.length === 1 ? nodeById.get(selectedNodes[0].id) ?? null : null;
  const popEdge = edgePop ? map?.edges.find((e) => e.id === edgePop.id) ?? null : null;
  const nodeIds = new Set(map?.nodes.map((n) => n.id) ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {map ? (
        <MapHeader
          map={map}
          maps={maps}
          canEdit={canEdit}
          canOperate={canOperate}
          onSelectMap={onSelectMap}
          onDeleted={onDeleted}
          live={!q.isError}
          actions={
            <>
              <Button size="sm" variant="ghost" leftIcon={<LayoutGrid />} onClick={relayout} disabled={map.nodes.length < 2} title={canEdit ? "Lay the map out left to right and save it for everyone" : "Lay the map out left to right (only for you)"}>
                Re-layout
              </Button>
              {detected && canOperate && (
                <Button
                  size="sm"
                  variant="primary"
                  leftIcon={<Copy />}
                  loading={copyMap.isPending}
                  onClick={() =>
                    copyMap.mutate(
                      { id: map.id, name: map.name },
                      { onSuccess: (m) => (toast.success(`Copied to "${m.name}": draw on it freely`), onSelectMap(m.id)), onError: (e) => toast.error(errorMessage(e)) },
                    )
                  }
                >
                  Copy to edit
                </Button>
              )}
              {canEdit && (
                <div className="relative">
                  <Button size="sm" variant="primary" leftIcon={<Plus />} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
                    Add queue
                  </Button>
                  {adding && (
                    <AddQueuePopover
                      onNodeIds={nodeIds}
                      connectionColor={(cid) => connectionColor(cid, connOrder)}
                      onClose={() => setAdding(false)}
                      onAdd={(ref) => addNode.mutate({ mapId, input: ref }, { onError: (e) => toast.error(errorMessage(e)) })}
                    />
                  )}
                </div>
              )}
            </>
          }
        />
      ) : (
        <div className="flex h-12 items-center border-b border-border bg-surface px-4">
          <Spinner label="Loading map…" />
        </div>
      )}

      <div ref={container} className="relative min-h-0 flex-1">
        <EdgeLabelClickContext.Provider value={openEdgePop}>
          <ReactFlow<QueueNode, FlowEdgeT>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={(_, __, dragged) => dragged.forEach((n) => dragging.current.add(n.id))}
            onNodeDragStop={onDragStop}
            onMoveStart={(e) => {
              if (e) lastUserMove.current = Date.now();
            }}
            onEdgeClick={(e, edge) => openEdgePop(edge.id, e)}
            onPaneClick={() => setEdgePop(null)}
            onConnect={onConnect}
            isValidConnection={(c) => c.source !== c.target}
            onBeforeDelete={onBeforeDelete}
            deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
            nodesConnectable={canEdit}
            connectionRadius={28}
            minZoom={0.2}
            maxZoom={1.75}
            proOptions={{ hideAttribution: true }}
            colorMode="system"
            className={cn("fm-canvas bg-bg", canEdit && "fm-editable")}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} position="bottom-right" />
            {nodes.length > 8 && (
              <MiniMap pannable zoomable position="bottom-left" nodeColor={() => "var(--surface-3)"} maskColor="color-mix(in srgb, var(--bg) 70%, transparent)" style={{ width: 160, height: 100 }} />
            )}
          </ReactFlow>
        </EdgeLabelClickContext.Provider>

        {/* Legend: arrows always, connections when the map crosses them */}
        {map && map.nodes.length > 0 && (
          <div className="pointer-events-none absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-col gap-1.5">
            <div className="pointer-events-auto w-fit rounded-md border border-border bg-surface/95 px-2.5 py-1.5 shadow-sm backdrop-blur-sm">
              <EdgeLegend />
              {multi && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-border pt-1.5">
                  <span className="mr-0.5 text-[10px] tracking-wider text-fg-subtle uppercase">Connections</span>
                  {spans.map((s) => (
                    <ConnectionChip key={s.connectionId} name={`${s.name} · ${s.count}`} color={s.color} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {map && map.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto">
              <EmptyState
                icon={<Sparkles />}
                title="This map is empty"
                description="Add a queue, or ask your AI client (MCP) to draw this flow."
                action={
                  canEdit && (
                    <Button size="sm" variant="primary" leftIcon={<Plus />} onClick={() => setAdding(true)}>
                      Add queue
                    </Button>
                  )
                }
              />
            </div>
          </div>
        )}

        {canEdit && map && map.nodes.length >= 2 && map.edges.length === 0 && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-[11px] text-fg-muted shadow-sm">
            Drag from a queue's right edge to another queue to draw an arrow.
          </div>
        )}

        {selectedNode && (
          <NodePanel
            node={selectedNode}
            multi={multi}
            color={connectionColor(selectedNode.connectionId, connOrder)}
            canEdit={canEdit}
            removing={removeNode.isPending}
            onRemove={() => removeNode.mutate({ mapId, nodeId: selectedNode.id }, { onError: (e) => toast.error(errorMessage(e)) })}
          />
        )}

        {edgePop && popEdge && (
          <EdgePopover
            key={popEdge.id}
            edge={popEdge}
            from={nodeById.get(popEdge.from)}
            to={nodeById.get(popEdge.to)}
            x={edgePop.x}
            y={edgePop.y}
            canEdit={canEdit}
            saving={updateEdge.isPending}
            deleting={deleteEdge.isPending}
            onClose={() => setEdgePop(null)}
            onSave={(label) =>
              updateEdge.mutate(
                { mapId, edgeId: popEdge.id, input: { label } },
                { onSuccess: () => setEdgePop(null), onError: (e) => toast.error(errorMessage(e)) },
              )
            }
            onDelete={() =>
              deleteEdge.mutate({ mapId, edgeId: popEdge.id }, { onSuccess: () => setEdgePop(null), onError: (e) => toast.error(errorMessage(e)) })
            }
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header: breadcrumb, inline rename, map actions
// ---------------------------------------------------------------------------

function MapHeader({
  map,
  maps,
  canEdit,
  canOperate,
  live,
  actions,
  onSelectMap,
  onDeleted,
}: {
  map: FlowMap;
  maps: FlowMapSummary[];
  canEdit: boolean;
  canOperate: boolean;
  live: boolean;
  actions: React.ReactNode;
  onSelectMap: (id: string) => void;
  onDeleted: (parentId: string | null) => void;
}) {
  const update = useUpdateFlowMap();
  const del = useDeleteFlowMap();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(map.name);
  const [moving, setMoving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!editing) setName(map.name);
  }, [map.name, editing]);
  const detected = map.kind === "detected";
  const ancestors = detected ? [] : ancestorsOf(maps, map.id);
  const children = maps.filter((m) => m.parentId === map.id);
  const parentName = map.parentId ? maps.find((m) => m.id === map.parentId)?.name : null;

  const saveName = () => {
    const n = name.trim();
    if (!n || n === map.name) {
      setEditing(false);
      setName(map.name);
      return;
    }
    update.mutate({ id: map.id, input: { name: n } }, { onSuccess: () => setEditing(false), onError: (e) => toast.error(errorMessage(e)) });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {detected ? <Link2 className="size-4 shrink-0 text-teal" aria-hidden /> : <Workflow className="size-4 shrink-0 text-pro" aria-hidden />}
        {ancestors.map((a) => (
          <span key={a.id} className="flex min-w-0 items-center gap-1 text-[13px] text-fg-subtle">
            <button type="button" className="max-w-32 truncate hover:text-fg" onClick={() => onSelectMap(a.id)}>
              {a.name}
            </button>
            <ChevronRight className="size-3.5 shrink-0" aria-hidden />
          </span>
        ))}
        {editing ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              saveName();
            }}
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="!h-7 w-64"
              aria-label="Map name"
              onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setName(map.name))}
            />
            <Button size="icon-sm" type="submit" variant="primary" aria-label="Save name" loading={update.isPending}>
              <Check />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => (setEditing(false), setName(map.name))}>
              <X />
            </Button>
          </form>
        ) : (
          <h1 className="group flex min-w-0 items-center gap-1 text-sm font-semibold">
            <span className="truncate" title={map.description ?? map.name}>
              {map.name}
            </span>
            {canEdit && (
              <Button size="icon-xs" variant="ghost" className="opacity-60 group-hover:opacity-100" aria-label="Rename map" title="Rename" onClick={() => setEditing(true)}>
                <Pencil />
              </Button>
            )}
          </h1>
        )}
        {detected && (
          <Tooltip content="From BullMQ FlowProducer: computed from the parent links of sampled jobs. Read-only; copy it to edit." side="bottom">
            <Badge variant="teal" size="xs">
              detected
            </Badge>
          </Tooltip>
        )}
        {!detected && !canOperate && (
          <Badge variant="outline" size="xs">
            read-only
          </Badge>
        )}
        <span className="hidden shrink-0 text-xs text-fg-muted sm:inline">
          {formatNumber(map.nodes.length)} {map.nodes.length === 1 ? "queue" : "queues"} · {formatNumber(map.edges.length)} {map.edges.length === 1 ? "arrow" : "arrows"}
        </span>
        {live && (
          <Tooltip content="Live: counts and changes made elsewhere (other users, MCP clients) show up within seconds." side="bottom">
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-subtle">
              <span className="status-dot pulse size-1.5 bg-success text-success" aria-hidden />
              Live
            </span>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {actions}
        {canEdit && (
          <>
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <Button size="icon-sm" variant="ghost" title="Move to…" aria-label="Move map" onClick={() => setMoving(true)}>
              <FolderInput />
            </Button>
            <Button size="icon-sm" variant="ghost" className="hover:text-danger" title="Delete map" aria-label="Delete map" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {map.description && <p className="w-full truncate pl-6 text-xs text-fg-muted">{map.description}</p>}

      {canEdit && <MoveMapDialog open={moving} map={map} maps={maps} onClose={() => setMoving(false)} />}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete "${map.name}"`}
        description={
          children.length > 0
            ? `Its ${children.length === 1 ? "child map moves" : `${children.length} child maps move`} up to ${parentName ? `"${parentName}"` : "the top level"}. The queues themselves are untouched.`
            : "Only the drawing goes away. The queues themselves are untouched."
        }
        confirmText="Delete map"
        danger
        loading={del.isPending}
        onConfirm={() =>
          del.mutate(map.id, {
            onSuccess: () => (setConfirmDelete(false), toast.success("Map deleted"), onDeleted(map.parentId)),
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating panels
// ---------------------------------------------------------------------------

function NodePanel({ node, multi, color, canEdit, removing, onRemove }: { node: FlowMapNode; multi: boolean; color: string; canEdit: boolean; removing: boolean; onRemove: () => void }) {
  return (
    <div className="fm-pop absolute top-3 right-3 z-10 w-72 rounded-lg border border-border bg-surface p-3 text-xs shadow-[var(--shadow)]">
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={node.queueName}>
          {node.queueName}
        </span>
        {node.isPaused && (
          <Badge variant="warning" size="xs">
            paused
          </Badge>
        )}
      </div>
      <div className="mb-2">
        <ConnectionChip name={node.connectionName} color={multi ? color : null} />
      </div>
      {node.missing ? (
        <p className="text-fg-muted">Not found on this connection: renamed, not created yet, or the connection is down.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-fg-muted">
          {(Object.entries(node.counts) as [string, number][]).map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-border/60 py-0.5">
              <dt>{k}</dt>
              <dd className="num text-fg">{formatNumber(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-3 flex items-center gap-2">
        {!node.missing && (
          <Link to={routes.queue(node.connectionId, node.queueName)} className="inline-flex items-center gap-1 text-accent hover:underline">
            Open queue <ExternalLink className="size-3" />
          </Link>
        )}
        {canEdit && (
          <Button size="xs" variant="ghost" className="ml-auto hover:text-danger" leftIcon={<Trash2 />} loading={removing} onClick={onRemove} title="Remove from map (Delete)">
            Remove from map
          </Button>
        )}
      </div>
    </div>
  );
}

function EdgePopover({
  edge,
  from,
  to,
  x,
  y,
  canEdit,
  saving,
  deleting,
  onClose,
  onSave,
  onDelete,
}: {
  edge: FlowMapEdge;
  from?: FlowMapNode;
  to?: FlowMapNode;
  x: number;
  y: number;
  canEdit: boolean;
  saving: boolean;
  deleting: boolean;
  onClose: () => void;
  onSave: (label: string | null) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(edge.label ?? "");
  const manual = edge.source === "manual";
  const editable = manual && canEdit;
  const cross = from && to && from.connectionId !== to.connectionId;
  return (
    <div
      className="fm-pop absolute z-20 w-72 rounded-lg border border-border bg-surface p-3 text-xs shadow-[var(--shadow)]"
      style={{ left: `min(${x + 8}px, calc(100% - 18.5rem))`, top: `min(${y + 8}px, calc(100% - 11rem))` }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1 font-mono text-[12px] font-semibold">
            <span className="truncate">{from?.queueName ?? edge.from}</span>
            <ArrowRight className="size-3 shrink-0 text-fg-subtle" aria-hidden />
            <span className="truncate">{to?.queueName ?? edge.to}</span>
          </div>
          {cross && (
            <p className="mt-0.5 text-[11px] text-fg-muted">
              Crosses connections: {from.connectionName} → {to.connectionName}
            </p>
          )}
        </div>
        <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      {manual ? (
        editable ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSave(label.trim() || null);
            }}
          >
            <Input autoFocus label="Label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="e.g. on success" className="!h-7" />
            <div className="mt-2.5 flex items-center gap-2">
              <Button size="xs" variant="ghost" className="hover:text-danger" leftIcon={<Trash2 />} loading={deleting} onClick={onDelete}>
                Delete arrow
              </Button>
              <Button size="xs" variant="primary" type="submit" className="ml-auto" loading={saving} disabled={(edge.label ?? "") === label.trim()}>
                Save
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-fg-muted">{edge.label ? `Label: ${edge.label}` : "Drawn by hand, no label."}</p>
        )
      ) : (
        <div className="space-y-1 text-fg-muted">
          <p>
            <Badge variant="teal" size="xs">
              detected
            </Badge>{" "}
            from BullMQ FlowProducer.
          </p>
          <p>{formatNumber(edge.evidence)} sampled jobs in the child queue point to a parent in the other one. It disappears on its own once none do.</p>
        </div>
      )}
    </div>
  );
}
