import { describe, expect, it } from "vitest";
import { mergeNotes } from "@/data/supabase/notesMerge";
import type { CloudNote } from "@/data/supabase/terminalNotes";

const note = (ticker: string, body: string, updatedAt: string): CloudNote => ({
  ticker,
  body,
  updatedAt,
});

describe("mergeNotes — cross-device conflict resolution", () => {
  it("adopts remote-only notes (write on desktop → appears on phone)", () => {
    const out = mergeNotes({}, [note("AAPL", "cloud note", "2026-06-15T00:00:00Z")], new Map());
    expect(out).toEqual({ AAPL: "cloud note" });
  });

  it("keeps local-only notes (a pull never drops a local note)", () => {
    const out = mergeNotes({ NVDA: "local only" }, [], new Map());
    expect(out).toEqual({ NVDA: "local only" });
  });

  it("leaves identical notes untouched", () => {
    const out = mergeNotes({ AAPL: "same" }, [note("AAPL", "same", "2026-06-15T00:00:00Z")], new Map());
    expect(out).toEqual({ AAPL: "same" });
  });

  it("adopts remote on conflict when it is newer than our last sync stamp", () => {
    const stamps = new Map([["AAPL", "2026-06-15T00:00:00Z"]]);
    const out = mergeNotes(
      { AAPL: "old local" },
      [note("AAPL", "newer remote", "2026-06-15T12:00:00Z")],
      stamps,
    );
    expect(out).toEqual({ AAPL: "newer remote" });
  });

  it("keeps local on conflict when remote is NOT newer than our stamp", () => {
    const stamps = new Map([["AAPL", "2026-06-15T12:00:00Z"]]);
    const out = mergeNotes(
      { AAPL: "fresh local" },
      [note("AAPL", "stale remote", "2026-06-15T00:00:00Z")],
      stamps,
    );
    expect(out).toEqual({ AAPL: "fresh local" });
  });

  it("keeps local on conflict when there is no stamp (no evidence remote is newer)", () => {
    const out = mergeNotes(
      { AAPL: "local edit before first sync" },
      [note("AAPL", "remote", "2026-06-15T00:00:00Z")],
      new Map(),
    );
    expect(out).toEqual({ AAPL: "local edit before first sync" });
  });

  it("ignores empty remote bodies and never emits blank notes", () => {
    const out = mergeNotes({ AAPL: "keep" }, [note("MSFT", "   ", "2026-06-15T00:00:00Z")], new Map());
    expect(out).toEqual({ AAPL: "keep" });
  });

  it("unions both sides on a multi-ticker merge", () => {
    const out = mergeNotes(
      { AAPL: "a-local", TSLA: "t-local" },
      [note("AAPL", "a-local", "2026-06-15T00:00:00Z"), note("NVDA", "n-remote", "2026-06-15T00:00:00Z")],
      new Map(),
    );
    expect(out).toEqual({ AAPL: "a-local", TSLA: "t-local", NVDA: "n-remote" });
  });
});
