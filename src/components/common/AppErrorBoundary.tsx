import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Outermost, app-level error boundary - the last line of defence.
 *
 * `RouteErrorBoundary` only wraps the routed `<Outlet>` inside `AppShell`, so a
 * throw in the persistent chrome (Sidebar, TopBar, CommandBar, ToastHost,
 * ResearchNarrator, DataSourceGate), in `App`'s own body/effects, or in the
 * router/provider setup itself would unmount the ENTIRE React tree to a blank
 * white screen with no way back. This boundary sits directly under the React
 * root, above `<App/>`, and renders a calm full-page recovery card instead.
 *
 * Because it lives above all chrome and routing, there is no "switch tabs to
 * recover" affordance here (none of that is mounted) - the only safe recovery is
 * a full reload, which re-runs bootstrap from a clean slate.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[App] fatal render error above the route tree:", error, info.componentStack);
  }

  private readonly reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app-crash" role="alert">
        <div className="app-crash__card empty feed-state feed-state--error">
          <span className="feed-state__lamp" aria-hidden />
          <h3>Catalyzed Alpha hit a snag</h3>
          <p>
            Something interrupted the app before it could finish loading. Your data is safe — a
            quick reload rebuilds the session from scratch.
          </p>
          <div className="tw-crash__actions">
            <button type="button" className="btn btn--primary" onClick={this.reload}>
              Reload app
            </button>
          </div>
          {import.meta.env.DEV ? (
            <pre className="tw-crash__detail mono">{error.message || String(error)}</pre>
          ) : null}
        </div>
      </div>
    );
  }
}
