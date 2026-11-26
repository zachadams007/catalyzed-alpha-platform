import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * What this boundary wraps, used in the fallback copy + console tag
   * (e.g. "Terminal wire", "security workspace", "spread").
   */
  label?: string;
  /**
   * When this value changes the boundary clears its error and re-renders its
   * children. Pass the route key (pathname / ticker) so navigating away from a
   * broken view automatically recovers instead of sticking on the fallback.
   */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Route-level error boundary for the Terminal surfaces.
 *
 * The whole app mounts under a single React root with no boundary, so a throw
 * anywhere in a Terminal page (a malformed wire item, a hung snapshot effect,
 * an unexpected null) unmounts the ENTIRE tree - the white-screen-then-Reload
 * crash testers hit. Wrapping each Terminal route in this boundary contains the
 * blast radius: a hiccup degrades to a calm, on-brand retry card while the rest
 * of the app (sidebar, command bar, other tabs) keeps working.
 *
 * It deliberately lives in the Terminal lane and is composed INSIDE each page
 * component (not the router), so it needs no change to the shared App shell.
 */
export class TerminalErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface for diagnosis (console only) - never rethrow, never crash again.
    console.error(
      `[Terminal] caught render error in ${this.props.label ?? "terminal"}:`,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(prev: Props): void {
    // Recover automatically when the caller's reset key changes (route change).
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private readonly retry = (): void => {
    // Clear the error and re-attempt the render. A transient data hiccup
    // recovers; a deterministic fault simply re-shows this card (no loop).
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const label = this.props.label ?? "terminal";
    return (
      <div className="empty feed-state feed-state--error tw-crash" role="alert">
        <span className="feed-state__lamp" aria-hidden />
        <h3>This view hit a snag</h3>
        <p>
          A data hiccup interrupted the {label}. Nothing was lost — retry to rebuild it, or reload
          the app if it persists.
        </p>
        <div className="tw-crash__actions">
          <button type="button" className="btn btn--primary" onClick={this.retry}>
            Retry
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => window.location.reload()}
          >
            Reload app
          </button>
        </div>
        {import.meta.env.DEV ? (
          <pre className="tw-crash__detail mono">{error.message || String(error)}</pre>
        ) : null}
      </div>
    );
  }
}
