/**
 * "All queues": every queue of one connection with the edges detected from
 * BullMQ flows plus the connection-level manual edges (`/flow-edges`). This is
 * the page Flows was before maps; maps are the curated view on top of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useEdgesState, useNodesState } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowRight, Database, ExternalLink, Info, LayoutGrid, Plus, RefreshCw, Trash2, Workflow, X } from "lucide-react";
import type { FlowEdge, FlowGraph } from "@bullpane/shared";
import { routes } from "@/lib/routes";
import { formatNumber } from "@/lib/format";
import { layoutGraph } from "@/lib/flowLayout";
import { useConnections, useCreateFlowEdge, useDeleteFlowEdge, useFlows } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { EdgeLabelClickContext, EdgeLegend, LAYOUT, NODE_H, NODE_W, edgeTypes, nodeTypes, toFlowEdge, type FlowEdgeT, type QueueNode } from "./canvasParts";

export function ConnectionGraph({ connectionId }: { connectionId: string }) {
  const navigate = useNavigate();
  const { isOperator } = useAuth();
  const connections = useConnections();
  const connection = connections.data?.find((c) => c.id === connectionId);
  const [sample, setSample] = useState(200);
  const flows = useFlows(connectionId, sample);
  const createEdge = useCreateFlowEdge();
  const deleteEdge = useDeleteFlowEdge();

  const [nodes, setNodes, onNodesChange] = useNodesState<QueueNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdgeT>([]);
  const moved = useRef(new Map<string, { x: number; y: number }>());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Rebuild on new data; keep positions the user dragged and the nodes' measured size.
  useEffect(() => {
    const g: FlowGraph | undefined = flows.data;
    if (!g) return;
    const pos = layoutGraph(g.nodes.map((n) => ({ id: n.id })), g.edges.map(drawnDirection), LAYOUT);
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return g.nodes.map((n) => {
        const data = { queueName: n.queueName, connectionId, connectionName: null, connectionColor: null, counts: n.counts, isPaused: n.isPaused, missing: false };
        const p = prevById.get(n.id);
        if (p) return { ...p, data };
        const at = moved.current.get(n.id) ?? pos.get(n.id) ?? { x: 0, y: 0 };
        return { id: n.id, type: "queue" as const, position: { x: at.x, y: at.y }, data, width: NODE_W, height: NODE_H, deletable: false };
      });
    });
    setEdges(g.edges.map((e) => ({ ...toFlowEdge(drawnDirection(e)), deletable: false })));
  }, [flows.data, connectionId, setNodes, setEdges]);

  const resetLayout = useCallback(() => {
    moved.current.clear();
    const g = flows.data;
    if (!g) return;
    const pos = layoutGraph(g.nodes.map((n) => ({ id: n.id })), g.edges.map(drawnDirection), LAYOUT);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
  }, [flows.data, setNodes]);

  const detected = flows.data?.edges.filter((e) => e.source === "detected").length ?? 0;
  const manual = flows.data?.edges.filter((e) => e.source === "manual").length ?? 0;
  const found = selectedEdgeId ? flows.data?.edges.find((e) => e.id === selectedEdgeId) : undefined;
  const selectedEdge: FlowEdge | null = found ? drawnDirection(found) : null;
  const selectedNodeId = nodes.find((n) => n.selected)?.id;
  const selectedNode = selectedNodeId ? flows.data?.nodes.find((n) => n.id === selectedNodeId) ?? null : null;
  const openEdge = useCallback((id: string) => setSelectedEdgeId(id), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2">
        <Database className="size-4 text-fg-subtle" aria-hidden />
        <h1 className="shrink-0 text-sm font-semibold">
          All queues <span className="font-normal text-fg-muted">· {connection?.name ?? connectionId}</span>
        </h1>
        <Select aria-label="Sample size" className="!h-7 !w-auto text-xs" value={String(sample)} onChange={(e) => setSample(Number(e.target.value))} options={[50, 200, 500, 1000].map((n) => ({ value: String(n), label: `sample ${n} jobs/queue` }))} />
        <span className="hidden min-w-0 truncate text-xs text-fg-muted xl:inline">
          {flows.data ? (
            <>
              {formatNumber(flows.data.nodes.length)} queues · {detected} detected · {manual} manual · sampled {formatNumber(flows.data.sampledJobs)} jobs
            </>
          ) : flows.isLoading ? (
            <Spinner label="Detecting flows…" />
          ) : null}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" leftIcon={<RefreshCw />} onClick={() => flows.refetch()} loading={flows.isFetching}>
            Refresh
          </Button>
          <Button size="sm" variant="ghost" leftIcon={<LayoutGrid />} onClick={resetLayout}>
            Re-layout
          </Button>
          {isOperator && (
            <Button size="sm" variant="primary" leftIcon={<Plus />} onClick={() => setAdding(true)} disabled={!flows.data || flows.data.nodes.length < 2}>
              Add edge
            </Button>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {flows.isError && !flows.data && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <EmptyState title="Could not load flows" description={errorMessage(flows.error)} />
          </div>
        )}
        {flows.data && flows.data.nodes.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <EmptyState icon={<Workflow />} title="No queues on this connection" description="Flows are built from the queues discovered on the connection." />
          </div>
        )}
        <EdgeLabelClickContext.Provider value={openEdge}>
          <ReactFlow<QueueNode, FlowEdgeT>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={(_, n) => moved.current.set(n.id, n.position)}
            onEdgeClick={(_, e) => setSelectedEdgeId(e.id)}
            onNodeClick={() => setSelectedEdgeId(null)}
            onPaneClick={() => setSelectedEdgeId(null)}
            onNodeDoubleClick={(_, n) => navigate(routes.queue(connectionId, n.data.queueName))}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.75}
            nodesConnectable={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            colorMode="system"
            className="fm-canvas bg-bg"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} position="bottom-right" />
            <MiniMap pannable zoomable position="bottom-left" nodeColor={() => "var(--surface-3)"} maskColor="color-mix(in srgb, var(--bg) 70%, transparent)" style={{ width: 160, height: 100 }} />
          </ReactFlow>
        </EdgeLabelClickContext.Provider>

        <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2">
          <div className="pointer-events-auto w-fit rounded-md border border-border bg-surface/95 px-2.5 py-1.5 shadow-sm">
            <EdgeLegend />
          </div>
          <div className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border border-border bg-surface/95 px-3 py-2 text-[11px] text-fg-muted shadow-sm">
            <Info className="mt-px size-3.5 shrink-0 text-info" aria-hidden />
            <span>
              Detected edges come from BullMQ flows: children carry a <span className="font-mono">parent</span> reference, and the arrow points from the parent to each child queue it waits for. A worker that simply calls <span className="font-mono">otherQueue.add()</span> leaves no trace in Redis; draw those by hand, or build a flow map. Double-click a queue to open it.
            </span>
          </div>
        </div>

        {(selectedEdge || selectedNode) && (
          <div className="fm-pop absolute top-3 right-3 w-72 rounded-lg border border-border bg-surface p-3 text-xs shadow-[var(--shadow)]">
            {selectedNode && !selectedEdge && (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold">{selectedNode.queueName}</span>
                  {selectedNode.isPaused && <Badge variant="warning" size="xs">paused</Badge>}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-fg-muted">
                  {(Object.entries(selectedNode.counts) as [string, number][]).map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-border/60 py-0.5">
                      <dt>{k}</dt>
                      <dd className="num text-fg">{formatNumber(v)}</dd>
                    </div>
                  ))}
                </dl>
                <Link to={routes.queue(connectionId, selectedNode.queueName)} className="mt-3 inline-flex items-center gap-1 text-accent hover:underline">
                  Open queue <ExternalLink className="size-3" />
                </Link>
              </>
            )}
            {selectedEdge && (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[12px] font-semibold">
                    <span className="truncate">{selectedEdge.from}</span>
                    <ArrowRight className="size-3 shrink-0 text-fg-subtle" aria-hidden />
                    <span className="truncate">{selectedEdge.to}</span>
                  </span>
                  <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={() => setSelectedEdgeId(null)}>
                    <X />
                  </Button>
                </div>
                <div className="space-y-1 text-fg-muted">
                  <p>
                    Source:{" "}
                    <Badge variant={selectedEdge.source === "manual" ? "accent" : "teal"} size="xs">
                      {selectedEdge.source}
                    </Badge>
                  </p>
                  {selectedEdge.source === "detected" && <p>Evidence: {formatNumber(selectedEdge.evidence)} sampled jobs referenced this parent.</p>}
                  {selectedEdge.label && <p>Label: {selectedEdge.label}</p>}
                </div>
                {selectedEdge.source === "manual" && isOperator && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-3 hover:text-danger"
                    leftIcon={<Trash2 />}
                    loading={deleteEdge.isPending}
                    onClick={() => deleteEdge.mutate(selectedEdge.id, { onSuccess: () => (setSelectedEdgeId(null), toast.success("Edge removed")), onError: (e) => toast.error(errorMessage(e)) })}
                  >
                    Delete manual edge
                  </Button>
                )}
                {selectedEdge.source === "detected" && <p className="mt-2 text-fg-subtle">Detected edges disappear on their own once no sampled job references the parent.</p>}
              </>
            )}
          </div>
        )}
      </div>

      {flows.data && (
        <AddEdgeDialog
          open={adding}
          onClose={() => setAdding(false)}
          queues={flows.data.nodes.map((n) => n.queueName)}
          saving={createEdge.isPending}
          onSave={(from, to, label) =>
            createEdge.mutate({ connectionId, from, to, label: label || null }, { onSuccess: () => (setAdding(false), toast.success("Edge added")), onError: (e) => toast.error(errorMessage(e)) })
          }
        />
      )}
    </div>
  );
}

/**
 * Redis stores a detected edge child → parent; it is drawn parent → child, the
 * way a FlowProducer reads in code (same as on flow maps).
 */
function drawnDirection(e: FlowEdge): FlowEdge {
  return e.source === "detected" ? { ...e, from: e.to, to: e.from } : e;
}

function AddEdgeDialog({ open, onClose, queues, onSave, saving }: { open: boolean; onClose: () => void; queues: string[]; onSave: (from: string, to: string, label: string) => void; saving: boolean }) {
  const sorted = useMemo(() => [...queues].sort((a, b) => a.localeCompare(b)), [queues]);
  const [from, setFrom] = useState(sorted[0] ?? "");
  const [to, setTo] = useState(sorted[1] ?? "");
  const [label, setLabel] = useState("");
  const same = from === to;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Add manual edge"
      description="Document a producer → consumer relationship that Redis cannot observe."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={same || !from || !to} loading={saving} onClick={() => onSave(from, to, label.trim())}>
            Add edge
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select label="From (producer)" value={from} onChange={(e) => setFrom(e.target.value)} options={sorted.map((q) => ({ value: q, label: q }))} />
        <Select label="To (consumer)" value={to} onChange={(e) => setTo(e.target.value)} options={sorted.map((q) => ({ value: q, label: q }))} error={same ? "Pick two different queues" : undefined} />
        <Input label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="e.g. enqueues on success" />
      </div>
    </Dialog>
  );
}
