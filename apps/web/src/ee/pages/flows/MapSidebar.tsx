import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Database, Link2, Plus, Workflow } from "lucide-react";
import type { FlowMapSummary, RedisConnection } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { readStorage, writeStorage } from "@/lib/storage";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner, Skeleton } from "@/components/ui/Spinner";
import { buildMapTree, flattenTree, groupDetected } from "./flowMapLogic";

const COLLAPSED_KEY = "flowMaps.collapsed";
const FRESH_MS = 2_400;

export type FlowsSelection = { kind: "map"; id: string } | { kind: "connection"; id: string } | null;

/**
 * The map tree. Manual maps nest (optional); detected maps sit per connection,
 * read-only; "All queues" opens a connection's whole graph. Maps that appear
 * while the page is open (another user, an MCP client) flash once.
 */
export function MapSidebar({
  maps,
  loading,
  detectedComplete,
  connections,
  selection,
  canCreate,
  onSelect,
  onNewMap,
}: {
  maps: FlowMapSummary[];
  loading: boolean;
  detectedComplete: boolean;
  connections: RedisConnection[];
  selection: FlowsSelection;
  canCreate: boolean;
  onSelect: (s: NonNullable<FlowsSelection>) => void;
  onNewMap: (parentId: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readStorage<string[]>(COLLAPSED_KEY, [])));
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      writeStorage(COLLAPSED_KEY, [...n]);
      return n;
    });

  const tree = useMemo(() => buildMapTree(maps), [maps]);
  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);
  const detected = useMemo(() => groupDetected(maps, connections.map((c) => c.id)), [maps, connections]);
  const connName = (id: string) => connections.find((c) => c.id === id)?.name ?? id;
  const fresh = useFreshIds(maps, loading);
  const selectedMap = selection?.kind === "map" ? selection.id : null;

  // Reveal the selected map: expand its ancestors, once per selection.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedMap || revealed.current === selectedMap || maps.length === 0) return;
    revealed.current = selectedMap;
    const byId = new Map(maps.map((m) => [m.id, m]));
    let cur = byId.get(selectedMap)?.parentId ?? null;
    const open: string[] = [];
    while (cur && !open.includes(cur)) {
      open.push(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    if (open.some((id) => collapsed.has(id))) {
      setCollapsed((c) => {
        const n = new Set(c);
        open.forEach((id) => n.delete(id));
        writeStorage(COLLAPSED_KEY, [...n]);
        return n;
      });
    }
  }, [selectedMap, maps, collapsed]);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface xl:w-64" aria-label="Flow maps">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Workflow className="size-4 text-pro" aria-hidden />
        <span className="text-sm font-semibold">Flows</span>
        {canCreate && (
          <Button size="xs" variant="ghost" className="ml-auto" leftIcon={<Plus />} onClick={() => onNewMap(null)} title="New flow map">
            New map
          </Button>
        )}
      </div>

      <nav className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
        <Section title="Maps">
          {loading ? (
            <div className="space-y-1.5 px-2 py-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-2 py-1 text-[11px] leading-relaxed text-fg-subtle">
              No maps yet. A map is a named drawing of the queues one process goes through.
              {canCreate && (
                <>
                  {" "}
                  <button type="button" className="text-accent hover:underline" onClick={() => onNewMap(null)}>
                    New map
                  </button>
                </>
              )}
            </p>
          ) : (
            <ul role="tree" aria-label="Maps">
              {rows.map(({ map, depth, children }) => (
                <li key={map.id} role="treeitem" aria-expanded={children.length ? !collapsed.has(map.id) : undefined} aria-selected={selectedMap === map.id}>
                  <Row
                    depth={depth}
                    selected={selectedMap === map.id}
                    fresh={fresh.has(map.id)}
                    icon={<Workflow className="size-3.5 shrink-0 text-pro/80" aria-hidden />}
                    label={map.name}
                    title={map.description ?? undefined}
                    count={map.nodeCount}
                    onSelect={() => onSelect({ kind: "map", id: map.id })}
                    expander={
                      children.length ? (
                        <button
                          type="button"
                          className="flex size-4 shrink-0 items-center justify-center rounded text-fg-subtle hover:text-fg"
                          onClick={() => toggle(map.id)}
                          aria-label={collapsed.has(map.id) ? `Expand ${map.name}` : `Collapse ${map.name}`}
                        >
                          <ChevronRight className={cn("size-3.5 transition-transform", !collapsed.has(map.id) && "rotate-90")} />
                        </button>
                      ) : (
                        <span className="size-4 shrink-0" />
                      )
                    }
                    action={
                      canCreate && (
                        <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" title={`New map inside "${map.name}"`} aria-label={`New map inside ${map.name}`} onClick={() => onNewMap(map.id)}>
                          <Plus />
                        </Button>
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>

        {(detected.length > 0 || !detectedComplete) && (
          <Section
            title="Detected"
            hint={
              <Tooltip content="From BullMQ FlowProducer: queues linked by the parent field of their jobs. Read-only; copy one to edit it." side="right">
                <span className="cursor-help normal-case tracking-normal">
                  <Badge />
                </span>
              </Tooltip>
            }
            right={!detectedComplete && <Spinner size={11} label="sampling" className="text-[10px] font-normal tracking-normal normal-case" />}
          >
            {detected.map((g) => (
              <div key={g.connectionId} className="mb-1">
                {(connections.length > 1 || detected.length > 1) && (
                  <div className="flex h-6 items-center gap-1.5 px-2 text-[11px] text-fg-subtle">
                    <Database className="size-3" aria-hidden />
                    <span className="truncate">{connName(g.connectionId)}</span>
                  </div>
                )}
                <ul>
                  {g.maps.map((m) => (
                    <li key={m.id}>
                      <Row
                        depth={0}
                        selected={selectedMap === m.id}
                        fresh={fresh.has(m.id)}
                        icon={<Link2 className="size-3.5 shrink-0 text-teal" aria-hidden />}
                        label={m.name}
                        title="From BullMQ FlowProducer (read-only)"
                        count={m.nodeCount}
                        onSelect={() => onSelect({ kind: "map", id: m.id })}
                        expander={<span className="size-4 shrink-0" />}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {detected.length === 0 && <p className="px-2 py-1 text-[11px] text-fg-subtle">Sampling jobs for parent links…</p>}
          </Section>
        )}

        <Section title="All queues">
          <ul>
            {connections.map((c) => (
              <li key={c.id}>
                <Row
                  depth={0}
                  selected={selection?.kind === "connection" && selection.id === c.id}
                  icon={<Database className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
                  label={c.name}
                  title={`Every queue on ${c.name}, with detected and manual edges`}
                  onSelect={() => onSelect({ kind: "connection", id: c.id })}
                  expander={<span className="size-4 shrink-0" />}
                />
              </li>
            ))}
          </ul>
        </Section>
      </nav>
    </aside>
  );
}

function Badge() {
  return <span className="rounded bg-teal/15 px-1 py-px text-[9px] font-medium text-teal">auto</span>;
}

function Section({ title, hint, right, children }: { title: string; hint?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-3">
      <h2 className="mb-1 flex h-5 items-center gap-1.5 px-2 text-[10px] font-semibold tracking-wider text-fg-subtle uppercase">
        {title}
        {hint}
        {right && <span className="ml-auto">{right}</span>}
      </h2>
      {children}
    </section>
  );
}

function Row({
  depth,
  selected,
  fresh,
  icon,
  label,
  title,
  count,
  onSelect,
  expander,
  action,
}: {
  depth: number;
  selected: boolean;
  fresh?: boolean;
  icon: ReactNode;
  label: string;
  title?: string;
  count?: number;
  onSelect: () => void;
  expander: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group flex h-7 min-w-0 items-center gap-1 rounded-md pr-1 text-[13px] transition-colors",
        selected ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
        fresh && !selected && "fm-tree-fresh",
      )}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {expander}
      <button type="button" onClick={onSelect} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left" aria-current={selected || undefined} title={title}>
        {icon}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="num ml-auto pl-1 text-[10px] text-fg-subtle group-hover:hidden">{count}</span>}
      </button>
      {action}
    </div>
  );
}

/** Ids that showed up after the first load, for FRESH_MS. */
function useFreshIds(maps: FlowMapSummary[], loading: boolean): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    if (loading) return;
    if (!seen.current) {
      seen.current = new Set(maps.map((m) => m.id));
      return;
    }
    const added = maps.filter((m) => !seen.current!.has(m.id)).map((m) => m.id);
    if (added.length === 0) return;
    added.forEach((id) => seen.current!.add(id));
    setFresh((f) => new Set([...f, ...added]));
    // Not cleared on the next poll: the list refetches every few seconds and the flash must still end.
    timers.current.push(window.setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), FRESH_MS));
  }, [maps, loading]);
  return fresh;
}
