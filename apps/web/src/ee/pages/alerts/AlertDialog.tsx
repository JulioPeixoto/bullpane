import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ALERT_KINDS, createAlertSchema, isErrorAlertKind, type Alert, type AlertChannel, type AlertCondition, type AlertKind, type AlertScope, type CreateAlertInput } from "@bullpane/shared";
import { useConnections, useCreateAlert, useFolders, useQueues, useUpdateAlert } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { toast } from "@/components/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/Input";
import { FolderMetricsWarning, QueueMetricsWarning } from "./MetricsRequirement";

export const KIND_LABEL: Record<AlertKind, string> = {
  // Say exactly what is counted: paused jobs are excluded on purpose, so
  // pausing a queue for maintenance no longer fires a backlog alert.
  waiting_above: "Waiting jobs above threshold (incl. prioritized, excl. paused)",
  failed_above: "Failures above threshold in a window (needs worker metrics)",
  failed_rate_above: "Failure rate above percent (needs worker metrics)",
  duration_above: "Processing time above (p50 / p95 of completed jobs)",
};

interface ChannelDraft {
  type: AlertChannel["type"];
  url: string;
  headersText: string;
}

interface Draft {
  name: string;
  enabled: boolean;
  scopeType: AlertScope["type"];
  connectionId: string;
  queueName: string;
  folderId: string;
  kind: AlertKind;
  threshold: string;
  windowMinutes: string;
  percent: string;
  minSample: string;
  seconds: string;
  percentile: "50" | "95";
  cooldownMinutes: string;
  channels: ChannelDraft[];
}

function emptyDraft(connectionId: string, scope?: AlertScope): Draft {
  return {
    name: "",
    enabled: true,
    scopeType: scope?.type ?? "queue",
    connectionId: scope?.type === "queue" || scope?.type === "connection" ? scope.connectionId : connectionId,
    queueName: scope?.type === "queue" ? scope.queueName : "",
    folderId: scope?.type === "folder" ? scope.folderId : "",
    kind: "failed_above",
    threshold: "10",
    windowMinutes: "5",
    percent: "5",
    minSample: "20",
    seconds: "30",
    percentile: "95",
    cooldownMinutes: "30",
    // Dashboard only until a channel is added: a rule is useful in Needs attention on its own.
    channels: [],
  };
}

function fromAlert(a: Alert): Draft {
  const c = a.condition;
  return {
    name: a.name,
    enabled: a.enabled,
    scopeType: a.scope.type,
    connectionId: a.scope.type === "queue" || a.scope.type === "connection" ? a.scope.connectionId : "",
    queueName: a.scope.type === "queue" ? a.scope.queueName : "",
    folderId: a.scope.type === "folder" ? a.scope.folderId : "",
    kind: c.kind,
    threshold: "threshold" in c ? String(c.threshold) : "10",
    windowMinutes: "windowMinutes" in c ? String(c.windowMinutes) : "5",
    percent: "percent" in c ? String(c.percent) : "5",
    minSample: "minSample" in c ? String(c.minSample) : "20",
    seconds: c.kind === "duration_above" ? String(c.seconds) : "30",
    percentile: c.kind === "duration_above" ? (String(c.percentile) as "50" | "95") : "95",
    cooldownMinutes: String(a.cooldownMinutes),
    channels: a.channels.map((ch) =>
      ch.type === "slack"
        ? { type: "slack", url: ch.webhookUrl, headersText: "" }
        : {
            type: "webhook",
            url: ch.url,
            headersText: Object.entries(ch.headers ?? {})
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n"),
          },
    ),
  };
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.indexOf(":");
    if (idx <= 0) throw new Error(`Header line "${t}" must look like "Name: value"`);
    out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function toInput(d: Draft): CreateAlertInput {
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  let condition: AlertCondition;
  switch (d.kind) {
    case "waiting_above":
      condition = { kind: "waiting_above", threshold: num(d.threshold) };
      break;
    case "failed_above":
      condition = { kind: "failed_above", threshold: num(d.threshold), windowMinutes: num(d.windowMinutes) };
      break;
    case "duration_above":
      condition = {
        kind: "duration_above",
        seconds: num(d.seconds),
        percentile: d.percentile === "50" ? 50 : 95,
        windowMinutes: num(d.windowMinutes),
        minSample: num(d.minSample),
      };
      break;
    default:
      condition = { kind: "failed_rate_above", percent: num(d.percent), windowMinutes: num(d.windowMinutes), minSample: num(d.minSample) };
      break;
  }
  const scope: AlertScope =
    d.scopeType === "folder"
      ? { type: "folder", folderId: d.folderId }
      : d.scopeType === "global"
        ? { type: "global" }
        : d.scopeType === "connection"
          ? { type: "connection", connectionId: d.connectionId }
          : { type: "queue", connectionId: d.connectionId, queueName: d.queueName };
  const channels: AlertChannel[] = d.channels.map((c) => (c.type === "slack" ? { type: "slack", webhookUrl: c.url.trim() } : { type: "webhook", url: c.url.trim(), headers: parseHeaders(c.headersText) }));
  return {
    name: d.name.trim(),
    enabled: d.enabled,
    scope,
    condition,
    channels,
    cooldownMinutes: num(d.cooldownMinutes),
  };
}

export function AlertDialog({
  open,
  onClose,
  alert,
  initialScope,
}: {
  open: boolean;
  onClose: () => void;
  alert: Alert | null;
  /**
   * Pre-scope a NEW alert (the queue page and the folder page both open this
   * dialog already pointed at what the user was looking at). Ignored when
   * editing an existing alert, whose own scope always wins.
   */
  initialScope?: AlertScope;
}) {
  const connections = useConnections();
  const create = useCreateAlert();
  const update = useUpdateAlert();
  const firstConnection = connections.data?.[0]?.id ?? "";
  const [draft, setDraft] = useState<Draft>(() => (alert ? fromAlert(alert) : emptyDraft(firstConnection, initialScope)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const queues = useQueues(draft.connectionId || undefined, { enabled: draft.scopeType === "queue" });
  const folders = useFolders();

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setChannel = (i: number, patch: Partial<ChannelDraft>) => setDraft((d) => ({ ...d, channels: d.channels.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const busy = create.isPending || update.isPending;

  const submit = () => {
    let input: CreateAlertInput;
    try {
      input = toInput(draft);
    } catch (e) {
      setErrors({ channels: (e as Error).message });
      return;
    }
    const parsed = createAlertSchema.safeParse(input);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const p = issue.path[0] === "condition" || issue.path[0] === "scope" ? String(issue.path[1] ?? issue.path[0]) : issue.path[0] === "channels" ? "channels" : String(issue.path[0]);
        next[p] = issue.path[0] === "channels" ? `Channel ${Number(issue.path[1]) + 1}: ${issue.message}` : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    const done = () => {
      toast.success(alert ? "Alert updated" : "Alert created");
      onClose();
    };
    if (alert) update.mutate({ id: alert.id, input: parsed.data }, { onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });
    else create.mutate(parsed.data, { onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={alert ? `Edit rule` : "New rule"}
      description="Evaluated on the server every few seconds. Every queue that breaks it shows up in Needs attention; add channels to be notified too."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={busy}>
            {alert ? "Save changes" : "Create rule"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Input label="Name" value={draft.name} onChange={(e) => set("name", e.target.value)} error={errors.name} autoFocus placeholder="payments: failures spiking" />
          <Field label="Enabled" className="justify-end">
            <Checkbox checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} label={draft.enabled ? "On" : "Off"} className="h-8 items-center" />
          </Field>
        </div>

        <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Scope</legend>
          <Select
            label="Watch"
            value={draft.scopeType}
            onChange={(e) => set("scopeType", e.target.value as AlertScope["type"])}
            options={[
              { value: "global", label: "Every queue" },
              { value: "connection", label: "Every queue on a connection" },
              { value: "folder", label: "Every queue in a folder" },
              { value: "queue", label: "One queue" },
            ]}
          />
          {draft.scopeType === "global" ? (
            <p className="self-end pb-2 text-xs text-fg-muted sm:col-span-2">
              Every discovered queue on every connection, except hidden ones.
            </p>
          ) : draft.scopeType === "connection" ? (
            <Select
              label="Connection"
              value={draft.connectionId}
              onChange={(e) => set("connectionId", e.target.value)}
              error={errors.connectionId}
              wrapperClassName="sm:col-span-2"
              options={(connections.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
            />
          ) : draft.scopeType === "queue" ? (
            <>
              <Select
                label="Connection"
                value={draft.connectionId}
                onChange={(e) => setDraft((d) => ({ ...d, connectionId: e.target.value, queueName: "" }))}
                error={errors.connectionId}
                options={(connections.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
              />
              <Select
                label="Queue"
                value={draft.queueName}
                onChange={(e) => set("queueName", e.target.value)}
                error={errors.queueName}
                options={[{ value: "", label: queues.isLoading ? "Loading…" : "Pick a queue", disabled: true }, ...(queues.data ?? []).map((q) => ({ value: q.name, label: q.name }))]}
              />
            </>
          ) : (
            <Select
              label="Folder"
              value={draft.folderId}
              onChange={(e) => set("folderId", e.target.value)}
              error={errors.folderId}
              wrapperClassName="sm:col-span-2"
              options={[{ value: "", label: folders.isLoading ? "Loading…" : folders.data?.length ? "Pick a folder" : "No folders yet", disabled: true }, ...(folders.data ?? []).map((f) => ({ value: f.id, label: f.parentId ? `${folders.data?.find((p) => p.id === f.parentId)?.name ?? "?"} / ${f.name}` : f.name }))]}
            />
          )}
          <p className="text-[11px] text-fg-subtle sm:col-span-3">
            {draft.scopeType === "queue"
              ? "A rule on one queue replaces wider rules of the same kind for that queue."
              : "Wide rules flag each queue that breaks them and notify once, naming the worst. The most specific rule of each kind wins: a queue or folder rule overrides this one for its queues."}
          </p>
        </fieldset>

        <fieldset className="grid gap-3 rounded-md border border-border p-3">
          <legend className="px-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Condition</legend>
          <Select label="Kind" value={draft.kind} onChange={(e) => set("kind", e.target.value as AlertKind)} options={ALERT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
          <div className="grid gap-3 sm:grid-cols-3">
            {(draft.kind === "waiting_above" || draft.kind === "failed_above") && (
              <Input label={draft.kind === "waiting_above" ? "Waiting jobs above" : "Failures above"} type="number" min={1} value={draft.threshold} onChange={(e) => set("threshold", e.target.value)} error={errors.threshold} />
            )}
            {draft.kind === "failed_rate_above" && <Input label="Failure rate above (%)" type="number" min={0.1} max={100} step={0.1} value={draft.percent} onChange={(e) => set("percent", e.target.value)} error={errors.percent} />}
            {draft.kind === "duration_above" && (
              <>
                <Input label="Slower than (seconds)" type="number" min={0.001} step={0.1} value={draft.seconds} onChange={(e) => set("seconds", e.target.value)} error={errors.seconds} />
                <Select
                  label="Percentile"
                  value={draft.percentile}
                  onChange={(e) => set("percentile", e.target.value as "50" | "95")}
                  options={[
                    { value: "95", label: "p95 (the slow tail)" },
                    { value: "50", label: "p50 (the typical job)" },
                  ]}
                />
              </>
            )}
            {draft.kind !== "waiting_above" && (
              <Input label="Window (minutes)" type="number" min={1} max={1440} value={draft.windowMinutes} onChange={(e) => set("windowMinutes", e.target.value)} error={errors.windowMinutes} />
            )}
            {(draft.kind === "failed_rate_above" || draft.kind === "duration_above") && (
              <Input
                label={draft.kind === "duration_above" ? "Min sample (completed jobs)" : "Min sample (finished jobs)"}
                type="number"
                min={1}
                max={draft.kind === "duration_above" ? 100 : undefined}
                value={draft.minSample}
                onChange={(e) => set("minSample", e.target.value)}
                error={errors.minSample}
                hint="Ignore windows with fewer jobs."
              />
            )}
          </div>
          {draft.kind === "duration_above" && (
            <p className="text-xs text-fg-muted">
              Time from a job starting its final attempt to completing, over the newest 100 completed jobs in the window. BullMQ
              metrics count jobs but do not time them, so this reads completed jobs still in Redis: with{" "}
              <code className="font-mono">removeOnComplete: true</code> there is nothing to read and the rule never fires;{" "}
              <code className="font-mono">{"{ count: N }"}</code> keeps exactly the recent jobs it needs.
            </p>
          )}
          {isErrorAlertKind(draft.kind) && (
            <>
              <p className="text-xs text-fg-muted">
                Measured from BullMQ's own per-minute metrics, so the number is right even when{" "}
                <code className="font-mono">removeOnComplete</code> prunes the queue, and exact from the first evaluation —
                a restart does not reset the window.
              </p>
              {draft.scopeType === "queue"
                ? draft.connectionId && draft.queueName && <QueueMetricsWarning connectionId={draft.connectionId} queueName={draft.queueName} />
                : draft.scopeType === "folder"
                  ? draft.folderId && <FolderMetricsWarning folder={folders.data?.find((f) => f.id === draft.folderId)} />
                  : null}
            </>
          )}
        </fieldset>

        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Notify</legend>
          {draft.channels.length === 0 && (
            <p className="text-xs text-fg-muted">
              Dashboard only: breaking queues show up in <span className="text-fg">Needs attention</span> and the rule keeps its
              fired/resolved history, but nobody is notified. Add a channel to be told.
            </p>
          )}
          {draft.channels.map((c, i) => (
            <div key={i} className="grid gap-2 rounded-md bg-surface-2/50 p-2 sm:grid-cols-[130px_1fr_auto]">
              <Select aria-label="Channel type" value={c.type} onChange={(e) => setChannel(i, { type: e.target.value as ChannelDraft["type"] })} options={[{ value: "slack", label: "Slack webhook" }, { value: "webhook", label: "Webhook (POST)" }]} />
              <Input aria-label="URL" mono placeholder={c.type === "slack" ? "https://hooks.slack.com/services/…" : "https://example.com/hooks/bullmq"} value={c.url} onChange={(e) => setChannel(i, { url: e.target.value })} />
              <Button size="icon" variant="ghost" aria-label="Remove channel" className="hover:text-danger" onClick={() => setDraft((d) => ({ ...d, channels: d.channels.filter((_, j) => j !== i) }))}>
                <Trash2 />
              </Button>
              {c.type === "webhook" && (
                <Textarea aria-label="Headers" mono rows={2} placeholder={"Authorization: Bearer …\nX-Source: bullpane"} value={c.headersText} onChange={(e) => setChannel(i, { headersText: e.target.value })} wrapperClassName="sm:col-span-3" hint="One header per line, Name: value" />
              )}
            </div>
          ))}
          {errors.channels && (
            <p className="text-xs text-danger" role="alert">
              {errors.channels}
            </p>
          )}
          <Button size="sm" variant="ghost" leftIcon={<Plus />} onClick={() => setDraft((d) => ({ ...d, channels: [...d.channels, { type: "webhook", url: "", headersText: "" }] }))}>
            Add channel
          </Button>
        </fieldset>

        {draft.channels.length > 0 && <Input label="Cooldown (minutes)" type="number" min={1} max={1440} value={draft.cooldownMinutes} onChange={(e) => set("cooldownMinutes", e.target.value)} error={errors.cooldownMinutes} hint="Minimum time between notifications while the rule keeps firing." wrapperClassName="max-w-xs" />}
      </div>
    </Dialog>
  );
}
