import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Popover } from "@/components/common/Popover";
import { searchSymbols, type SymbolRecord } from "@/data/symbols/symbolDirectory";

/* ────────────────────────────────────────────────────────────────────────
 * Pure helpers (unit-tested in node - no DOM needed). Kept exported so the
 * rendering layer stays declarative and the matching/keyboard math is provable.
 * ──────────────────────────────────────────────────────────────────────── */

/** A run of text; `hit` marks the part that matched the query (for emphasis). */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Split `text` into segments, marking the first case-insensitive occurrence of
 * `query` so the matched run can be emphasised in the dropdown.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return [{ text, hit: false }];
  const out: HighlightSegment[] = [];
  if (idx > 0) out.push({ text: text.slice(0, idx), hit: false });
  out.push({ text: text.slice(idx, idx + q.length), hit: true });
  if (idx + q.length < text.length) out.push({ text: text.slice(idx + q.length), hit: false });
  return out;
}

/** Wrap an index into [0, len) for arrow-key cycling; -1 when the list is empty. */
export function wrapIndex(next: number, len: number): number {
  if (len <= 0) return -1;
  return ((next % len) + len) % len;
}

/* ──────────────────────────────────────────────────────────────────────── */

export interface SymbolAutocompleteProps {
  /** Controlled query text. */
  value: string;
  onChange: (value: string) => void;
  /** Commit a chosen listing - click, or Enter on the active row. */
  onPick: (record: SymbolRecord) => void;
  /**
   * Enter with text but no results (or no active row). When omitted, a wrapping
   * `<form>` submits naturally. When results are present, Enter always commits
   * the active (or best) row via `onPick`, so name lookups resolve correctly.
   */
  onSubmitText?: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** Stable id root for the input + listbox wiring; auto-generated otherwise. */
  id?: string;
  name?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Max suggestions to surface. */
  limit?: number;
  /** Field chrome to match the host surface. */
  variant?: "panel" | "pill";
  size?: "md" | "sm";
  /** Leading adornment (typically a search icon). */
  leading?: ReactNode;
  /** Trailing adornment (typically a submit button). */
  trailing?: ReactNode;
  className?: string;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const segs = highlightSegments(text, query);
  return (
    <>
      {segs.map((s, i) =>
        s.hit ? (
          <mark key={i} className="sym-ac__hit">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function exchangeShort(rec: SymbolRecord): string {
  // Compact, recognisable venue tag (the directory stores full venue strings).
  const x = rec.exchange.toUpperCase();
  if (x.includes("NASDAQ")) return "NASDAQ";
  if (x.includes("ARCA")) return "NYSE ARCA";
  if (x.includes("NYSE")) return "NYSE";
  if (x.includes("CBOE")) return rec.country === "CA" ? "CBOE CA" : "CBOE";
  if (x.includes("TSXV") || x === "TSX VENTURE") return "TSXV";
  if (x.includes("TSX")) return "TSX";
  if (x.includes("IEX")) return "IEX";
  return rec.exchange;
}

/**
 * Reusable, accessible (WAI-ARIA combobox) ticker autocomplete backed by the
 * offline symbol directory. Debounced, keyboard-navigable, reduced-motion-safe.
 * Surfaces symbol + company name + venue/ETF chip across every search surface.
 */
export function SymbolAutocomplete({
  value,
  onChange,
  onPick,
  onSubmitText,
  placeholder,
  ariaLabel,
  id,
  name,
  autoFocus,
  disabled,
  limit = 8,
  variant = "panel",
  size = "md",
  leading,
  trailing,
  className,
}: SymbolAutocompleteProps) {
  const reactId = useId();
  const baseId = id ?? `sym-ac-${reactId}`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [deferred, setDeferred] = useState(value);

  const fieldRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Debounce the (synchronous) directory search so we re-rank on a pause, not
  // on every keystroke - matches the app's other live inputs.
  useEffect(() => {
    const handle = setTimeout(() => setDeferred(value), 110);
    return () => clearTimeout(handle);
  }, [value]);

  const results = useMemo(() => {
    const q = deferred.trim();
    return q ? searchSymbols(q, limit) : [];
  }, [deferred, limit]);

  // Auto-highlight the best match so Enter commits it (name → correct symbol).
  useEffect(() => {
    setActive(results.length > 0 ? 0 : -1);
  }, [results]);

  const menuVisible = open && deferred.trim().length > 0;

  // Keep the active row scrolled into view (deferred per preview rAF gotcha).
  useEffect(() => {
    if (!menuVisible || active < 0) return;
    const t = setTimeout(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(optionId(active))}`)
        ?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => clearTimeout(t);
    // optionId is derived from baseId (stable); active/menuVisible drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, menuVisible]);

  const commit = (rec: SymbolRecord) => {
    setOpen(false);
    onPick(rec);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!menuVisible) {
        setOpen(true);
        return;
      }
      setActive((i) => wrapIndex(i + 1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!menuVisible) return;
      setActive((i) => wrapIndex((i < 0 ? 0 : i) - 1, results.length));
    } else if (e.key === "Enter") {
      if (menuVisible && results.length > 0) {
        e.preventDefault();
        commit(results[active >= 0 ? active : 0]);
      } else if (onSubmitText) {
        e.preventDefault();
        setOpen(false);
        onSubmitText(value);
      }
      // else: let a wrapping <form> submit.
    } else if (e.key === "Escape") {
      if (menuVisible) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div
      className={`sym-ac sym-ac--${variant} sym-ac--${size}${className ? ` ${className}` : ""}`}
    >
      <div ref={fieldRef} className="sym-ac__field">
        {leading ? (
          <span className="sym-ac__leading" aria-hidden>
            {leading}
          </span>
        ) : null}
        <input
          id={baseId}
          name={name}
          className="sym-ac__input"
          type="text"
          role="combobox"
          aria-expanded={menuVisible}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={menuVisible && active >= 0 ? optionId(active) : undefined}
          aria-label={ariaLabel}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- host opts in deliberately
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {trailing ? <span className="sym-ac__trailing">{trailing}</span> : null}
      </div>

      <Popover
        anchorRef={fieldRef}
        open={menuVisible}
        onClose={() => setOpen(false)}
        placement="bottom"
        align="start"
        matchAnchorWidth
        ariaLabel="Ticker matches"
      >
        {results.length > 0 ? (
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Ticker matches"
            className="sym-ac__menu"
          >
            {results.map((rec, i) => (
              <li
                key={rec.symbol}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`sym-ac__opt${i === active ? " is-active" : ""}`}
                onMouseDown={(e) => {
                  // Pre-empt input blur so the click lands on a live option.
                  e.preventDefault();
                  commit(rec);
                }}
                onMouseMove={() => setActive(i)}
              >
                <span className="sym-ac__sym mono">
                  <HighlightedText text={rec.symbol} query={value} />
                </span>
                <span className="sym-ac__name" title={rec.name}>
                  <HighlightedText text={rec.name} query={value} />
                </span>
                <span className="sym-ac__tags" aria-hidden>
                  {rec.isEtf ? <span className="sym-ac__chip sym-ac__chip--etf">ETF</span> : null}
                  <span className="sym-ac__chip">{exchangeShort(rec)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="sym-ac__menu sym-ac__menu--empty" role="status">
            <span className="sym-ac__empty">
              No listed match for <strong>“{value.trim()}”</strong>
            </span>
            <span className="sym-ac__empty-hint">
              Try a ticker (AAPL) or company name — US &amp; Canadian listings.
            </span>
          </div>
        )}
      </Popover>
    </div>
  );
}
