import { describe, expect, it } from "vitest";

/**
 * Regression (W4-D - route-level code-splitting): App.tsx used to statically
 * import every ~25 page component, so production shipped one ~2.97MB raw /
 * ~688KB gzip eager index chunk and /today's first paint parsed Terminal,
 * Heatmap, Admin, Performance, Compare, Spread, etc. that a user may never open.
 *
 * The fix converts the heavy, non-default routes to `React.lazy(() => import(...))`
 * (the proven CoreGuide pattern under HashRouter) and wraps each lazy route's
 * <Route element> in a <Suspense fallback={<Loader/>}>. TodayFeed must stay a
 * static import because it's the index redirect target.
 *
 * These assertions read App.tsx's source and lock the split in: a future refactor
 * that re-adds a static `import { Terminal } from "@/pages/Terminal"` (or drops a
 * Suspense boundary) re-bloats the eager bundle and fails here. We assert on
 * source text rather than rendering because the vitest env is `node` (no DOM).
 *
 * App.tsx is loaded as a raw string via Vite's import.meta.glob (no Node `fs`
 * dependency, so this also typechecks under the app's tsconfig - same approach as
 * the migration RLS-intent tests).
 */
const appModules = import.meta.glob("../App.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const appSource = Object.values(appModules)[0] ?? "";

// Heavy routes that MUST be lazily code-split off the eager index chunk.
const LAZY_PAGES = [
  "CoreGuide",
  "Heatmap",
  "PortfolioDetail",
  "ResearchDesk",
  "SignalForge",
  "Terminal",
  // TerminalWorkspace retired 2026-06-25 - /terminal/:ticker now redirects to the
  // canonical /signal/:ticker page, so the workspace is no longer a routed page.
  "TerminalCompare",
  "TerminalSpread",
  "Admin",
  "Performance",
] as const;

// Pages that MUST stay eager (index redirect target + the light feeds that share
// its deps, so feed↔feed navigation has no Suspense flash).
const EAGER_PAGES = ["TodayFeed", "WeeklyFeed", "ForYouFeed"] as const;

describe("App route code-splitting", () => {
  it("loaded App.tsx source for static analysis", () => {
    expect(appSource.length).toBeGreaterThan(0);
  });

  for (const page of LAZY_PAGES) {
    it(`${page} is lazy-loaded via React.lazy + dynamic import`, () => {
      // A `const X = lazy(() => import("@/pages/X")...)` declaration.
      const lazyDecl = new RegExp(
        `const\\s+${page}\\s*=\\s*lazy\\(\\s*\\(\\)\\s*=>\\s*\\n?\\s*import\\(\\s*["']@/pages/${page}["']`,
      );
      expect(
        lazyDecl.test(appSource),
        `${page} should be declared with React.lazy(() => import("@/pages/${page}"))`,
      ).toBe(true);

      // And it must NOT also be a static import (that would defeat the split -
      // the static import alone would pull it back into the eager chunk).
      const staticImport = new RegExp(
        `^\\s*import\\s*\\{[^}]*\\b${page}\\b[^}]*\\}\\s*from\\s*["']@/pages/${page}["']`,
        "m",
      );
      expect(
        staticImport.test(appSource),
        `${page} must not also be statically imported`,
      ).toBe(false);
    });
  }

  for (const page of EAGER_PAGES) {
    it(`${page} stays eagerly imported (index redirect path)`, () => {
      const staticImport = new RegExp(
        `import\\s*\\{[^}]*\\b${page}\\b[^}]*\\}\\s*from\\s*["']@/pages/${page}["']`,
      );
      expect(staticImport.test(appSource)).toBe(true);
      // Belt-and-suspenders: it should not have been turned into a lazy const.
      expect(new RegExp(`const\\s+${page}\\s*=\\s*lazy\\(`).test(appSource)).toBe(false);
    });
  }

  it("every lazy page is rendered inside a <Suspense> boundary", () => {
    // Each lazy element must be wrapped so the dynamic chunk has a fallback while
    // it loads. We require at least as many <Suspense fallback=...> wrappers as
    // lazy pages (CoreGuide + the 10 heavy routes).
    const suspenseCount = (appSource.match(/<Suspense\s+fallback=/g) ?? []).length;
    expect(suspenseCount).toBeGreaterThanOrEqual(LAZY_PAGES.length);

    // And each lazy page must appear as a JSX element somewhere (rendered, not
    // just declared).
    for (const page of LAZY_PAGES) {
      expect(
        new RegExp(`<${page}\\s*/>`).test(appSource),
        `${page} should be rendered as <${page} />`,
      ).toBe(true);
    }
  });

  it("the Loader fallback is imported for the Suspense boundaries", () => {
    expect(/import\s*\{\s*Loader\s*\}\s*from\s*["']@\/components\/common\/Loader["']/.test(appSource)).toBe(true);
  });
});
