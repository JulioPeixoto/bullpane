import type { SchedulerPromoteMode } from "@bullpane/shared";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { formatDateTime } from "@/lib/format";

/** The delayed job a scheduler produced, as far as this dialog needs it. */
export interface SchedulerJobRef {
  id: string;
  repeatJobKey: string;
  delayedUntil: number | null;
}

const OPTIONS: { mode: SchedulerPromoteMode; title: string; detail: (at: string) => string }[] = [
  {
    mode: "run_copy",
    title: "Run a copy now",
    detail: (at) => `A one-off copy runs now. The scheduled run at ${at} still happens.`,
  },
  {
    mode: "skip_next",
    title: "Promote and skip the next run",
    detail: (at) => `The run scheduled for ${at} runs now instead. Nothing runs at ${at}; the scheduler continues with the run after it.`,
  },
];

/**
 * Promoting a job scheduler's delayed job is not neutral: that job IS the next run, and
 * bullmq schedules the one after it from this job's own time. Neither outcome is right
 * for every case (an extra import today vs moving today's import earlier), so the
 * operator picks. See SchedulerPromoteMode.
 */
export function PromoteSchedulerJobDialog({
  job,
  onClose,
  onPick,
  pending,
}: {
  job: SchedulerJobRef | null;
  onClose: () => void;
  onPick: (mode: SchedulerPromoteMode) => void;
  pending?: SchedulerPromoteMode | null;
}) {
  const at = job?.delayedUntil ? formatDateTime(job.delayedUntil) : "its scheduled time";
  return (
    <Dialog
      open={job !== null}
      onClose={onClose}
      size="md"
      title="Promote a scheduled job"
      description={
        job ? (
          <>
            Job <span className="font-mono">{job.id}</span> is the next run of scheduler{" "}
            <span className="font-mono">{job.repeatJobKey}</span>.
          </>
        ) : undefined
      }
      footer={
        <Button variant="ghost" size="sm" onClick={onClose} disabled={!!pending}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {OPTIONS.map((o) => (
          <button
            key={o.mode}
            type="button"
            disabled={!!pending}
            onClick={() => onPick(o.mode)}
            className="rounded-md border border-border bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-3 disabled:opacity-60"
          >
            <span className="block text-sm font-medium text-fg">
              {o.title}
              {pending === o.mode && "…"}
            </span>
            <span className="mt-0.5 block text-xs text-fg-muted">{o.detail(at)}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
