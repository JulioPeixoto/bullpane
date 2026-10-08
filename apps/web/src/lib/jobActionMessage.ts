import type { JobActionKind, JobActionResponse } from "../api/hooks";

const DONE: Record<JobActionKind, string> = {
  retry: "retried",
  promote: "promoted",
  remove: "removed",
  discard: "discarded",
};

/** Toast text for a single-job action. For a scheduler's job, the operator must know which promote happened. */
export function jobActionMessage(jobId: string, action: JobActionKind, result?: JobActionResponse): string {
  if (action === "promote" && result?.mode === "ran_copy") {
    return `Job ${jobId} belongs to scheduler "${result.schedulerId}": ran a copy (${result.jobId}) now, the next scheduled run is unchanged`;
  }
  if (action === "promote" && result?.mode === "skipped_next") {
    return `Job ${jobId} promoted: scheduler "${result.schedulerId}" skips the run it was scheduled for`;
  }
  return `Job ${jobId} ${DONE[action]}`;
}
