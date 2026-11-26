import type { CloudNote } from "./terminalNotes";

/**
 * Pure merge/diff helpers for cross-device Terminal-notes sync. Kept free of any
 * store/Supabase import so it stays trivially unit-testable (notesSync.ts wires
 * these into the live store + network).
 */

export type NotesMap = Record<string, string>;

/** Stable serialization (key-sorted) to detect real changes. */
export function serializeNotes(notes: NotesMap): string {
  return JSON.stringify(
    Object.keys(notes)
      .sort()
      .map((k) => [k, notes[k]]),
  );
}

/**
 * Merge local notes with the cloud rows. Pure.
 *
 *  - remote-only ticker → adopt the remote body.
 *  - local-only ticker  → keep it (never dropped by a pull).
 *  - both differ        → adopt remote ONLY if it's strictly newer than the
 *                         stamp we last synced for that ticker; else keep local
 *                         (the reconciling push then updates the cloud).
 *
 * Never emits an empty body (cleared notes delete their row instead).
 */
export function mergeNotes(
  local: NotesMap,
  remote: CloudNote[],
  knownStamps: Map<string, string>,
): NotesMap {
  const out: NotesMap = { ...local };
  for (const r of remote) {
    if (!r.body || !r.body.trim()) continue; // defensive: cleared notes delete rows
    const localVal = local[r.ticker];
    if (localVal == null) {
      out[r.ticker] = r.body; // remote-only
      continue;
    }
    if (localVal === r.body) continue; // identical
    const stamp = knownStamps.get(r.ticker);
    if (stamp && Date.parse(r.updatedAt) > Date.parse(stamp)) {
      out[r.ticker] = r.body; // remote is newer than our last sync point
    }
    // else keep local (out already holds it)
  }
  for (const k of Object.keys(out)) {
    if (!out[k] || !out[k].trim()) delete out[k];
  }
  return out;
}

/** Diff two note maps → the tickers whose body changed/added/removed. */
export function diffChangedTickers(next: NotesMap, prev: NotesMap): string[] {
  const keys = new Set([...Object.keys(next), ...Object.keys(prev)]);
  const out: string[] = [];
  for (const k of keys) if (next[k] !== prev[k]) out.push(k);
  return out;
}
