import { useRef, useState } from "react";
import type { BulkJobFailure } from "@bullpane/shared";
import { usePromoteMatching } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { formatNumber } from "@/lib/format";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/Toast";

interface Progress {
  promoted: number;
  failedCount: number;
  failed: BulkJobFailure[];
  scanned: number;
  total: number;
  done: boolean;
}

/**
 * Promotes every delayed job of a group and / or matching a search, not only the
 * ones on screen. Each server call is bounded and returns a cursor; this loops
 * over them, shows the running count, and can be stopped between calls.
 */
export function PromoteMatchingDialog({
  open,
  onClose,
  connectionId,
  queue,
  match,
}: {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  queue: string;
  match: { query?: string; groupId?: string };
}) {
  const promote = usePromoteMatching(connectionId, queue);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  const what = [match.groupId ? `of group ${match.groupId}` : null, match.query ? `containing "${match.query}"` : null].filter(Boolean).join(" and ");

  const start = async () => {
    stop.current = false;
    setRunning(true);
    let acc: Progress = { promoted: 0, failedCount: 0, failed: [], scanned: 0, total: 0, done: false };
    setProgress(acc);
    let cursor: string | undefined;
    try {
      do {
        const r = await promote.mutateAsync({ ...match, cursor });
        acc = {
          promoted: acc.promoted + r.promoted,
          failedCount: acc.failedCount + r.failedCount,
          failed: [...acc.failed, ...r.failed].slice(0, 20),
          scanned: acc.scanned + r.scanned,
          total: r.total,
          done: r.nextCursor === null,
        };
        setProgress(acc);
        cursor = r.nextCursor ?? undefined;
      } while (cursor !== undefined && !stop.current);
      if (acc.failedCount === 0) toast.success(`${formatNumber(acc.promoted)} delayed jobs promoted`);
      else toast.error(`${formatNumber(acc.promoted)} promoted · ${formatNumber(acc.failedCount)} failed`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    stop.current = true;
    if (!running) setProgress(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title="Promote every matching delayed job"
      description={`Every delayed job ${what} in ${queue}, not only the ones on screen, runs now. On a BullMQ Pro queue grouped jobs go back into their group and keep its rate limit.`}
      footer={
        running ? (
          <Button variant="ghost" size="sm" onClick={() => (stop.current = true)}>
            Stop after this batch
          </Button>
        ) : progress?.done || (progress && stop.current) ? (
          <Button size="sm" onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" onClick={start}>
              Promote all
            </Button>
          </>
        )
      }
    >
      {progress && (
        <div className="space-y-2 text-xs" role="status">
          <p>
            <span className="num font-semibold text-fg">{formatNumber(progress.promoted)}</span> promoted
            {progress.failedCount > 0 && (
              <>
                {" "}· <span className="num font-semibold text-danger">{formatNumber(progress.failedCount)}</span> failed
              </>
            )}{" "}
            · scanned <span className="num">{formatNumber(Math.min(progress.scanned, Math.max(progress.total, progress.scanned)))}</span> delayed jobs
            {progress.done ? " · done" : running ? "…" : " · stopped"}
          </p>
          {progress.failed.length > 0 && (
            <ul className="max-h-32 overflow-auto rounded border border-border p-2 font-mono text-[11px] text-fg-muted">
              {progress.failed.map((f) => (
                <li key={f.jobId} className="truncate">
                  {f.jobId}: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
