import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * The current route key (pathname). When it changes the boundary clears any
   * caught error and re-renders its children - so navigating to a different tab
   * after a crash recovers automatically, with NO full-app reload.
   */
  resetKey: string;
}

interface State {
  error: Error | null;
}

/**
 * App-wide route-level error boundary.
 *
 * The whole app mounts under a single React root. Before this, a throw anywhere
 * in a routed page (StockDetail, Portfolio, Beacon, Research, …) unmounted the
 * ENTIRE tree - the blank/"main" screen that demanded a full reload. Worse, a
 * single-instance boundary that never reset would keep showing its fallback for
 * the whole app until a reload.
 *
 * This boundary wraps the routed <Outlet> in AppShell and RESETS on every route
 * change (it's keyed on the location pathname): a crash degrades to a calm retry
 * card while the sidebar / topbar / command bar keep working, and simply
 * navigating to another tab clears the error and renders the new page - no reload.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[App] caught render error in routed view:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    // Recover automatically when the route changes (navigated to another tab).
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="empty feed-state feed-state--error tw-crash" role="alert">
        <span className="feed-state__lamp" aria-hidden />
        <h3>This view hit a snag</h3>
        <p>
          A data hiccup interrupted this view. Nothing was lost — switch tabs or retry to rebuild
          it. You don&apos;t need to reload.
        </p>
        <div className="tw-crash__actions">
          <button type="button" className="btn btn--primary" onClick={this.retry}>
            Retry
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => window.location.reload()}>
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
