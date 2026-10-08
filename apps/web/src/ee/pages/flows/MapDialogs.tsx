import { useEffect, useMemo, useState } from "react";
import { createFlowMapSchema, type FlowMap, type FlowMapSummary } from "@bullpane/shared";
import { useCreateFlowMap, useUpdateFlowMap } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { toast } from "@/components/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { moveTargets } from "./flowMapLogic";

const indent = (depth: number) => (depth > 1 ? "   ".repeat(depth - 1) + "└ " : "");

export function NewMapDialog({
  open,
  parentId,
  maps,
  onClose,
  onCreated,
}: {
  open: boolean;
  parentId: string | null;
  maps: FlowMapSummary[];
  onClose: () => void;
  onCreated: (m: FlowMap) => void;
}) {
  const create = useCreateFlowMap();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parent, setParent] = useState(parentId ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setError(null);
      setParent(parentId ?? "");
    }
  }, [open, parentId]);
  // Every manual map is a valid parent for a map that does not exist yet.
  const parents = useMemo(() => moveTargets(maps, "\u0000new"), [maps]);

  const submit = () => {
    const parsed = createFlowMapSchema.safeParse({ name, description: description.trim() || null, parentId: parent || null });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid");
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (m) => {
        toast.success(`Map "${m.name}" created`);
        onCreated(m);
        onClose();
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="New flow map"
      description="A named diagram of the queues one process goes through, on any connection."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={create.isPending}>
            Create map
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input label="Name" autoFocus value={name} onChange={(e) => (setName(e.target.value), setError(null))} error={error} maxLength={80} placeholder="e.g. Order checkout" />
        <Textarea label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} placeholder="What the process does, who owns it" />
        {parents.length > 1 && (
          <Select
            label="Inside"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            options={parents.map((t) => ({ value: t.id ?? "", label: t.id ? indent(t.depth) + t.label : "Top level" }))}
            hint="Optional. Nesting only groups maps; each map keeps its own diagram."
          />
        )}
      </form>
    </Dialog>
  );
}

export function MoveMapDialog({ open, map, maps, onClose }: { open: boolean; map: FlowMapSummary; maps: FlowMapSummary[]; onClose: () => void }) {
  const update = useUpdateFlowMap();
  const targets = useMemo(() => moveTargets(maps, map.id), [maps, map.id]);
  const [parent, setParent] = useState(map.parentId ?? "");
  useEffect(() => {
    if (open) setParent(map.parentId ?? "");
  }, [open, map.parentId]);
  const unchanged = (map.parentId ?? "") === parent;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={`Move "${map.name}"`}
      description="Its child maps move with it."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={unchanged}
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                { id: map.id, input: { parentId: parent || null } },
                { onSuccess: () => (toast.success("Map moved"), onClose()), onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Move
          </Button>
        </>
      }
    >
      <Select
        label="Move to"
        value={parent}
        onChange={(e) => setParent(e.target.value)}
        options={targets.map((t) => ({ value: t.id ?? "", label: t.id ? indent(t.depth) + t.label : "Top level" }))}
        hint="A map cannot go inside itself or one of its own children."
      />
    </Dialog>
  );
}
