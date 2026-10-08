import { describe, expect, it } from "vitest";
import { jobActionMessage } from "../jobActionMessage";

describe("jobActionMessage", () => {
  it("says a plain promote was a promote", () => {
    expect(jobActionMessage("42", "promote", { ok: true, mode: "promoted" })).toBe("Job 42 promoted");
  });

  it("tells the operator a scheduler's job ran as a copy and the next run is kept", () => {
    const text = jobActionMessage("repeat:nightly:1", "promote", { ok: true, mode: "ran_copy", jobId: "7", schedulerId: "nightly" });
    expect(text).toContain("ran a copy (7)");
    expect(text).toContain("next scheduled run is unchanged");
  });

  it("tells the operator the scheduler skips a run", () => {
    const text = jobActionMessage("repeat:nightly:1", "promote", { ok: true, mode: "skipped_next", schedulerId: "nightly" });
    expect(text).toContain('scheduler "nightly" skips');
  });
});
