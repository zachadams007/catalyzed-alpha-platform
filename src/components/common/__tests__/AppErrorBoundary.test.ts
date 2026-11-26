import { describe, expect, it } from "vitest";
import { AppErrorBoundary } from "@/components/common/AppErrorBoundary";

/**
 * Regression (D-1): before this boundary, `main.tsx` rendered `<App/>` with NO
 * error boundary above it - only `RouteErrorBoundary` inside `AppShell`, which
 * wraps just the routed `<Outlet>`. A throw in the persistent chrome, in `App`'s
 * own body/effects, or in router/provider setup unmounted the ENTIRE tree to a
 * blank white screen with no recovery. `AppErrorBoundary` is the outermost
 * catch-all; `getDerivedStateFromError` must capture the error into state so the
 * component renders its full-page reload fallback instead of re-throwing.
 *
 * (The render fallback itself is exercised by the running app - the node test env
 * has no DOM/testing-library, so we assert the pure state-derivation contract
 * that drives it.)
 */
describe("AppErrorBoundary", () => {
  it("derives an error state from a thrown error (so the fallback shows, not a blank screen)", () => {
    const boom = new Error("chrome crashed before the router mounted");
    expect(AppErrorBoundary.getDerivedStateFromError(boom)).toEqual({ error: boom });
  });
});
