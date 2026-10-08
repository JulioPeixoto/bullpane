import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Database, Plus, Search } from "lucide-react";
import { flowMapNodeId, type FlowMapNodeRef } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { useAllQueues } from "@/api/hooks";
import { Spinner } from "@/components/ui/Spinner";

interface Option extends FlowMapNodeRef {
  id: string;
  connectionName: string;
  onMap: boolean;
}

/**
 * Searchable queue combobox across every connection, grouped by connection.
 * A queue is "connection + queue name": the same name on two connections is two
 * entries and two nodes, so every pick carries its own connectionId. The
 * connection filter chips narrow the list to one connection first.
 * Stays open after a pick so several queues can be added in a row.
 */
export function AddQueuePopover({
  onNodeIds,
  onAdd,
  onClose,
  connectionColor,
}: {
  onNodeIds: ReadonlySet<string>;
  onAdd: (ref: FlowMapNodeRef) => void;
  onClose: () => void;
  /** colour of a connection already on the map, so the picker speaks the canvas' colours */
  connectionColor: (connectionId: string) => string | null;
}) {
  const { byConnection, isLoading } = useAllQueues();
  const [filter, setFilter] = useState("");
  const [onlyConnection, setOnlyConnection] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const f = filter.trim().toLowerCase();
  const groups = useMemo(
    () =>
      byConnection
        .filter((b) => !onlyConnection || b.connection.id === onlyConnection)
        .map(({ connection, queues }) => ({
          connection,
          options: queues
            .filter((q) => !f || q.name.toLowerCase().includes(f) || connection.name.toLowerCase().includes(f))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map<Option>((q) => {
              const ref = { connectionId: connection.id, queueName: q.name };
              const id = flowMapNodeId(ref);
              return { ...ref, id, connectionName: connection.name, onMap: onNodeIds.has(id) };
            }),
        }))
        .filter((g) => g.options.length > 0),
    [byConnection, f, onlyConnection, onNodeIds],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const multi = byConnection.length > 1;

  useEffect(() => setActive(0), [f, onlyConnection]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (o: Option | undefined) => {
    if (!o || o.onMap) return;
    onAdd({ connectionId: o.connectionId, queueName: o.queueName });
  };

  let index = -1;
  return (
    <div
      ref={root}
      className="fm-pop absolute top-full right-0 z-30 mt-1.5 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow)]"
      role="dialog"
      aria-label="Add a queue to this map"
    >
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            autoFocus
            className="control !h-8 pl-8"
            placeholder={multi ? "Search queues on every connection…" : "Search queues…"}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            role="combobox"
            aria-expanded
            aria-controls="fm-add-queue-list"
            aria-activedescendant={flat[active] ? `fm-opt-${active}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(flat.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(flat[active]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        {multi && (
          <div className="mt-2 flex flex-wrap gap-1" role="radiogroup" aria-label="Connection">
            <ConnFilter label="All" active={!onlyConnection} onClick={() => setOnlyConnection(null)} />
            {byConnection.map(({ connection }) => (
              <ConnFilter
                key={connection.id}
                label={connection.name}
                color={connectionColor(connection.id)}
                active={onlyConnection === connection.id}
                onClick={() => setOnlyConnection((c) => (c === connection.id ? null : connection.id))}
              />
            ))}
          </div>
        )}
      </div>
      <ul id="fm-add-queue-list" ref={list} role="listbox" className="max-h-80 overflow-y-auto p-1">
        {isLoading && (
          <li className="flex justify-center py-6">
            <Spinner label="Loading queues…" />
          </li>
        )}
        {!isLoading && flat.length === 0 && <li className="px-3 py-6 text-center text-xs text-fg-subtle">No queue matches.</li>}
        {groups.map((g) => (
          <li key={g.connection.id} role="presentation">
            {multi && (
              <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-fg-subtle uppercase">
                <Database className="size-3" style={{ color: connectionColor(g.connection.id) ?? undefined }} aria-hidden />
                {g.connection.name}
              </div>
            )}
            <ul role="presentation">
              {g.options.map((o) => {
                index++;
                const i = index;
                return (
                  <li
                    key={o.id}
                    id={`fm-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={o.onMap || undefined}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o)}
                    className={cn(
                      "flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px]",
                      i === active && !o.onMap && "bg-surface-2",
                      o.onMap ? "cursor-default text-fg-subtle" : "text-fg",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.queueName}</span>
                    {o.onMap ? (
                      <span className="flex items-center gap-1 text-[11px]">
                        <Check className="size-3.5 text-success" aria-hidden /> on map
                      </span>
                    ) : (
                      i === active && <Plus className="size-3.5 text-fg-muted" aria-hidden />
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConnFilter({ label, active, color, onClick }: { label: string; active: boolean; color?: string | null; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
        active ? "border-accent bg-accent/15 text-fg" : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
      )}
    >
      {color !== undefined && <span className="size-1.5 rounded-full" style={{ background: color ?? "var(--fg-subtle)" }} aria-hidden />}
      {label}
    </button>
  );
}
