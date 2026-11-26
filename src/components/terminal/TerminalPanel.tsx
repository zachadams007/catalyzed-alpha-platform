import type { ReactNode } from "react";

interface TerminalPanelProps {
  /** Anchor id for command-bar `?panel=` deep-links. */
  id?: string;
  /**
   * Chassis title. Omit for reused panels that render their own heading - the
   * cell still gets the uniform border / background / scroll, just no header.
   */
  title?: string;
  /** Small right-of-title status line (e.g. "live" / source name). */
  hint?: ReactNode;
  /** Header-right slot for actions (refresh, regenerate). */
  headerRight?: ReactNode;
  /** Grid spanning modifier. */
  span?: "wide" | "tall" | "full";
  className?: string;
  children: ReactNode;
}

/**
 * Uniform panel chassis for the security workspace: a sticky header with a
 * title + hint + optional action slot over a scroll-contained body. Every
 * workspace panel lives in one so the grid reads like a dense terminal.
 */
export function TerminalPanel({
  id,
  title,
  hint,
  headerRight,
  span,
  className,
  children,
}: TerminalPanelProps) {
  const showHead = Boolean(title || hint || headerRight);
  return (
    <section
      id={id}
      className={`tw-panel${span ? ` tw-panel--${span}` : ""}${className ? ` ${className}` : ""}`}
    >
      {showHead ? (
        <div className="tw-panel__head">
          {title ? <h3 className="tw-panel__title">{title}</h3> : null}
          {hint ? <span className="tw-panel__hint">{hint}</span> : null}
          {headerRight ? <span className="tw-panel__actions">{headerRight}</span> : null}
        </div>
      ) : null}
      <div className="tw-panel__body">{children}</div>
    </section>
  );
}
