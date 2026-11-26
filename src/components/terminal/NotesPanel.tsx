import { useEffect, useRef, useState } from "react";
import { TerminalPanel } from "./TerminalPanel";
import { useAppStore } from "@/store/useAppStore";
import { IconCheck, IconTrash } from "@/components/icons";

const MAX_LEN = 4000;
const SAVE_DEBOUNCE_MS = 600;

interface NotesPanelProps {
  id?: string;
  ticker: string;
}

/**
 * Personal per-ticker research notes. Persisted in useAppStore keyed by ticker
 * (the workspace grid is keyed by ticker, so this remounts - and reloads the
 * right note - on every symbol change). Autosaves on a short debounce and on
 * blur. These are the user's own research notes - never advice, never orders.
 */
export function NotesPanel({ id, ticker }: NotesPanelProps) {
  const saved = useAppStore((s) => s.terminalNotes[ticker] ?? "");
  const setTerminalNote = useAppStore((s) => s.setTerminalNote);

  const [draft, setDraft] = useState(saved);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<number | null>(null);

  // Debounced autosave whenever the draft diverges from what's stored.
  useEffect(() => {
    if (draft === saved) {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      return;
    }
    setStatus("saving");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setTerminalNote(ticker, draft);
      setStatus("saved");
      timer.current = null;
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [draft, saved, ticker, setTerminalNote]);

  // Flush immediately on blur so a note is never lost to a fast tab-away.
  const flush = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (draft !== saved) {
      setTerminalNote(ticker, draft);
      setStatus("saved");
    }
  };

  const clear = () => {
    setDraft("");
    setTerminalNote(ticker, "");
    setStatus("saved");
  };

  const statusLabel =
    status === "saving" ? "Saving…" : status === "saved" ? "Saved" : `${draft.length ? "" : "Empty"}`;

  const headerRight =
    draft.length > 0 ? (
      <button className="tw-icon-btn" onClick={clear} title="Clear note" aria-label="Clear note">
        <IconTrash size={14} />
      </button>
    ) : undefined;

  return (
    <TerminalPanel
      id={id}
      title="Notes"
      hint={
        status === "saved" ? (
          <span className="tw-note__saved">
            <IconCheck size={12} /> Saved
          </span>
        ) : status === "saving" ? (
          "Saving…"
        ) : (
          "private to this device"
        )
      }
      headerRight={headerRight}
    >
      <div className="tw-note">
        <textarea
          className="tw-note__area"
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_LEN))}
          onBlur={flush}
          placeholder={`Your research notes on ${ticker} — thesis, levels to watch, questions. Saved on this device only.`}
          aria-label={`Research notes for ${ticker}`}
          spellCheck
          rows={6}
        />
        <div className="tw-note__foot">
          <span className="text-faint">{statusLabel}</span>
          <span className="mono text-faint">
            {draft.length}/{MAX_LEN}
          </span>
        </div>
      </div>
    </TerminalPanel>
  );
}
