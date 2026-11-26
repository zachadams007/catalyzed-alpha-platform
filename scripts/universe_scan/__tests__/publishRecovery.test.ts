import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  easternDayKey,
  resolveArchiveReference,
  validateSavedScanForPublish,
} from "../publishRecovery.mjs";

function scan(sourceRunId = "scan_current_123") {
  return {
    run: { finishedAt: "2026-07-26T03:59:00.000Z" },
    meta: { learningArchive: { sourceRunId } },
  };
}

describe("saved scan recovery", () => {
  it("never carries a prior Eastern-day result across midnight, even for the expected attempt", () => {
    const { run, meta } = scan();
    expect(() =>
      validateSavedScanForPublish(run, meta, {
        now: new Date("2026-07-26T04:01:00.000Z"),
        expectedSourceRunId: "scan_current_123",
      }),
    ).toThrow(/different US\/Eastern day/);
  });

  it("accepts only the current attempt on the same Eastern day when an ID is supplied", () => {
    const run = { finishedAt: "2026-07-26T14:00:00.000Z" };
    const now = new Date("2026-07-26T14:05:00.000Z");
    expect(
      validateSavedScanForPublish(
        run,
        { learningArchive: { sourceRunId: "scan_current_123" } },
        { now, expectedSourceRunId: "scan_current_123" },
      ),
    ).toBe(Date.parse(run.finishedAt));
    expect(() =>
      validateSavedScanForPublish(
        run,
        { learningArchive: { sourceRunId: "scan_old_123" } },
        { now, expectedSourceRunId: "scan_current_123" },
      ),
    ).toThrow(/different scan attempt/);
  });

  it("rejects a stale same-day source-run pair from before the wrapper invocation", () => {
    expect(() =>
      validateSavedScanForPublish(
        {
          startedAt: "2026-07-26T13:00:00.000Z",
          finishedAt: "2026-07-26T13:05:00.000Z",
        },
        { learningArchive: { sourceRunId: "scan_stale_123" } },
        {
          now: new Date("2026-07-26T14:05:00.000Z"),
          expectedSourceRunId: "scan_stale_123",
          minimumStartedAtISO: "2026-07-26T14:00:00.000Z",
        },
      ),
    ).toThrow(/before this wrapper invocation/);
  });

  it("uses US/Eastern civil days at the UTC midnight boundary", () => {
    expect(easternDayKey(new Date("2026-07-26T03:59:00.000Z"))).toBe("2026-07-25");
    expect(easternDayKey(new Date("2026-07-26T04:00:00.000Z"))).toBe("2026-07-26");
  });

  it("keeps archive references inside the configured root", () => {
    const root = resolve("archive-root");
    expect(resolveArchiveReference(root, join("2026-07-26", "artifact.json"))).toBe(
      join(root, "2026-07-26", "artifact.json"),
    );
    expect(() => resolveArchiveReference(root, join("..", "outside.json"))).toThrow(/escapes/);
    expect(() => resolveArchiveReference(root, join(root, "artifact.json"))).toThrow(/relative/);
    if (process.platform === "win32") {
      expect(() => resolveArchiveReference(root, "D:\\other-drive\\artifact.json")).toThrow(/relative|escapes/);
    }
    expect(() => resolveArchiveReference(root, "")).toThrow(/empty/);
  });
});
