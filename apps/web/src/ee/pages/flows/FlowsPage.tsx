/**
 * Flows (Pro): flow maps on the left, the selected map's canvas on the right.
 *
 *   /flows                → first manual map, or the welcome state
 *   /flows?map=<id>       → one map (manual, or `detected:<cid>:<root>`)
 *   /flows/:connectionId  → "All queues" of one connection (the detected graph)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Bot, Plus, Workflow } from "lucide-react";
import { routes } from "@/lib/routes";
import { useConnections, useFlowMaps } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { MapSidebar, type FlowsSelection } from "./MapSidebar";
import { MapCanvas } from "./MapCanvas";
import { ConnectionGraph } from "./ConnectionGraph";
import { NewMapDialog } from "./MapDialogs";
import { buildMapTree } from "./flowMapLogic";
import "./flows.css";

/** /flows */
export function FlowsIndexPage() {
  const { has } = useEdition();
  if (!has("flows")) return <LockedFeature feature="flows" />;
  return <FlowsWorkspace />;
}

/** /flows/:connectionId */
export function FlowsPage() {
  const { has } = useEdition();
  if (!has("flows")) return <LockedFeature feature="flows" />;
  return <FlowsWorkspace />;
}

function FlowsWorkspace() {
  const { connectionId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { isOperator } = useAuth();
  const connections = useConnections();
  const flowMaps = useFlowMaps();
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);

  const maps = useMemo(() => flowMaps.data?.maps ?? [], [flowMaps.data]);
  const mapParam = connectionId ? null : search.get("map");
  const selection: FlowsSelection = connectionId ? { kind: "connection", id: connectionId } : mapParam ? { kind: "map", id: mapParam } : null;

  // /flows with nothing chosen: open the first manual map, if there is one.
  useEffect(() => {
    if (selection || !flowMaps.data) return;
    const first = buildMapTree(maps)[0];
    if (first) navigate(routes.flowMap(first.map.id), { replace: true });
  }, [selection, flowMaps.data, maps, navigate]);

  const select = useCallback(
    (s: NonNullable<FlowsSelection>) => navigate(s.kind === "map" ? routes.flowMap(s.id) : routes.flows(s.id)),
    [navigate],
  );
  const newMap = useCallback((parentId: string | null) => setCreating({ parentId }), []);

  return (
    <div className="flex h-full min-h-0">
      <MapSidebar
        maps={maps}
        loading={flowMaps.isLoading}
        detectedComplete={flowMaps.data?.detectedComplete ?? true}
        connections={connections.data ?? []}
        selection={selection}
        canCreate={isOperator}
        onSelect={select}
        onNewMap={newMap}
      />
      <div className="relative min-w-0 flex-1">
        {selection?.kind === "connection" ? (
          <ConnectionGraph key={selection.id} connectionId={selection.id} />
        ) : selection?.kind === "map" ? (
          <MapCanvas
            key={selection.id}
            mapId={selection.id}
            maps={maps}
            canOperate={isOperator}
            onSelectMap={(id) => select({ kind: "map", id })}
            onDeleted={(parentId) => navigate(parentId ? routes.flowMap(parentId) : routes.flows(), { replace: true })}
          />
        ) : (
          flowMaps.data && (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={<Workflow />}
                title="Draw how work moves through your queues"
                description={
                  <>
                    A flow map is a named diagram of the queues one process goes through, across any of your connections, with live counts on every queue. Draw it here, or ask your AI client (MCP) to draw it for you.
                    {maps.some((m) => m.kind === "detected") && " The detected maps on the left come straight from BullMQ FlowProducer."}
                  </>
                }
                action={
                  isOperator && (
                    <Button variant="primary" leftIcon={<Plus />} onClick={() => newMap(null)}>
                      New map
                    </Button>
                  )
                }
              />
            </div>
          )
        )}
        {!selection && flowMaps.data && (
          <p className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-[11px] text-fg-subtle">
            <Bot className="size-3.5" aria-hidden />
            MCP tools: create_flow_map, add_flow_queue, add_flow_edge
          </p>
        )}
      </div>
      <NewMapDialog
        open={!!creating}
        parentId={creating?.parentId ?? null}
        maps={maps}
        onClose={() => setCreating(null)}
        onCreated={(m) => select({ kind: "map", id: m.id })}
      />
    </div>
  );
}
