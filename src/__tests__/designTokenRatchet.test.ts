import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * DESIGN-TOKEN RATCHET
 *
 * `docs/design-system.md` says: "Reuse these. Do not hardcode colors, spacing,
 * radii, or shadows." A read-only audit (docs/qa/fe-defect-inventory.md, rows
 * #11-#15) sampled ~100 places that do anyway; this guard's first real count
 * found 400 across 55 files - raw `#hex` colors, `rgb()` literals, magic
 * `z-index` numbers in CSS, and inline `style={{ marginTop: 8 }}` pixel numbers
 * in TSX. Every one is a spot a theme change or the in-progress azure/gold
 * rebrand will miss.
 *
 * Mass-rewriting all 400 in one pass was judged too regression-prone to be
 * worth it. This test is the alternative: a RATCHET. It counts violations per
 * file and compares against the baseline below. A file may get BETTER (count
 * drops - then lower its baseline here) but never WORSE. New files start at 0.
 * So the class stops growing today, and the existing debt burns down whenever
 * someone touches a file, without a big-bang rewrite.
 *
 * Zero runtime dependencies on purpose: this repo has no eslint/stylelint, and
 * a lint stack is a bigger decision than this guard needs. It runs in the
 * existing `npx vitest run` gate (environment: node). Files are read with
 * `node:fs` rather than `import.meta.glob(?raw)` because vitest stubs every
 * `.css` module to an empty string regardless of query (its default `css:
 * false`), which would silently make the CSS half of this guard a no-op.
 */

const ROOT = join(__dirname, "..");

/** CSS: raw hex colors, rgb()/rgba() literals, numeric z-index. */
const CSS_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "raw #hex color", re: /#[0-9a-fA-F]{3,8}\b/g },
  // rgb(...) literals - but rgba(var(--x-rgb), a) is the SANCTIONED token form.
  { name: "rgb()/rgba() literal", re: /\brgba?\(\s*(?!var\()[0-9]/g },
  { name: "magic z-index", re: /\bz-index\s*:\s*-?\d+/g },
];

/** TSX: inline style objects carrying raw pixel numbers for spacing/type. */
const TSX_PATTERN = {
  name: "inline style px number",
  // style={{ ... marginTop: 8 ... }} / padding: 12 / fontSize: 13 / gap: 6 ...
  re: /\b(margin(Top|Bottom|Left|Right)?|padding(Top|Bottom|Left|Right)?|gap|fontSize|lineHeight|top|left|right|bottom|width|height|borderRadius)\s*:\s*\d+(\.\d+)?\s*[,}]/g,
};

/** Files exempt by design: the token file IS the source of raw values. */
const EXEMPT = new Set(["styles/tokens.css"]);

/**
 * BASELINE - violations per file as of 2026-09-16 (measured, not hand-typed).
 * Rules: a file may go DOWN (then update its number here). It may never go UP.
 * A file not listed is held to ZERO. Regenerate with:
 *   RATCHET_PRINT=1 npx vitest run src/__tests__/designTokenRatchet.test.ts
 */
const BASELINE: Record<string, number> = {
  "components/auth/SignInModal.tsx": 11,
  "components/common/FeedSkeleton.tsx": 9,
  "components/common/InteractivePriceChart.tsx": 4,
  "components/common/Loader.tsx": 2,
  "components/common/NewsSkeleton.tsx": 1,
  "components/common/PageHeader.tsx": 1,
  "components/common/PriceTargetsSkeleton.tsx": 2,
  "components/common/StockDetailSkeleton.tsx": 10,
  "components/common/Tooltip.tsx": 2,
  "components/feed/AiPickHero.tsx": 17,
  "components/groups/shared.tsx": 1,
  "components/layout/AppShell.tsx": 2,
  "components/layout/TopBar.tsx": 1,
  "components/ops/EngineOpsSection.tsx": 23,
  "components/ops/ModelRegistryCard.tsx": 2,
  "components/ops/RefreshLimit.tsx": 1,
  "components/performance/PerformanceColdStart.tsx": 1,
  "components/portfolio/CreatePortfolioModal.tsx": 2,
  "components/portfolio/PortfolioDeskEmptyState.tsx": 2,
  "components/portfolio/PortfolioValueChart.tsx": 4,
  "components/screen/DataModePill.tsx": 1,
  "components/screen/ForgeConsole.tsx": 2,
  "components/screen/TradeHorizonPicker.tsx": 5,
  "components/signal/AnalystTargetsStrip.tsx": 5,
  "components/signal/CatalystNewsPanel.tsx": 11,
  "components/signal/NewsPanel.tsx": 2,
  "components/signal/PriceChartModal.tsx": 12,
  "components/signal/ScoreBreakdown.tsx": 1,
  "components/signal/SecFilingsPanel.tsx": 2,
  "components/terminal/AiBriefPanel.tsx": 1,
  "components/terminal/QuoteHeader.tsx": 2,
  "components/terminal/SocialHeatPanel.tsx": 3,
  "pages/Admin.tsx": 3,
  "pages/ForYouFeed.tsx": 6,
  "pages/MyDesk.tsx": 5,
  "pages/Performance.tsx": 2,
  "pages/ResearchDesk.tsx": 7,
  "pages/StockDetail.tsx": 1,
  "pages/Terminal.tsx": 2,
  "pages/TerminalCompare.tsx": 3,
  "pages/TerminalSpread.tsx": 1,
  "styles/algorithm.css": 35,
  "styles/avatar.css": 2,
  "styles/base.css": 2,
  "styles/components.css": 119,
  "styles/desk-run-indicator.css": 2,
  "styles/forge-live.css": 15,
  "styles/groups.css": 3,
  "styles/heatmap.css": 19,
  "styles/ops.css": 2,
  "styles/performance.css": 3,
  "styles/portfolio-detail.css": 3,
  "styles/research-desk.css": 6,
  "styles/terminal.css": 8,
  "styles/watchlist.css": 1,
};

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function countIn(file: string): number {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (EXEMPT.has(rel)) return 0;
  const text = readFileSync(file, "utf8");
  // Strip comments so an explanatory "#04121b" in a comment isn't counted.
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (file.endsWith(".css")) {
    return CSS_PATTERNS.reduce((n, p) => n + (stripped.match(p.re)?.length ?? 0), 0);
  }
  return stripped.match(TSX_PATTERN.re)?.length ?? 0;
}

describe("design-token ratchet", () => {
  const files = [
    ...walk(join(ROOT, "styles"), [".css"]),
    ...walk(join(ROOT, "components"), [".tsx"]),
    ...walk(join(ROOT, "pages"), [".tsx"]),
  ];
  const current: Record<string, number> = {};
  for (const f of files) {
    const n = countIn(f);
    if (n > 0) current[relative(ROOT, f).replace(/\\/g, "/")] = n;
  }

  if (process.env.RATCHET_PRINT) {
    // eslint-disable-next-line no-console
    console.log("\nBASELINE =", JSON.stringify(current, null, 2));
  }

  it("actually reads the source set (guards against a walker that silently matches nothing)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(current["styles/components.css"] ?? 0).toBeGreaterThan(50);
  });

  it("no file has MORE hardcoded design values than its baseline", () => {
    const worse: string[] = [];
    for (const [file, n] of Object.entries(current)) {
      const allowed = BASELINE[file] ?? 0;
      if (n > allowed) worse.push(`${file}: ${n} (baseline ${allowed}, +${n - allowed})`);
    }
    expect(
      worse,
      `New hardcoded colors/px/z-index found. Use tokens from src/styles/tokens.css ` +
        `(see docs/design-system.md). If a value is genuinely new, add a token, don't inline it.\n` +
        worse.join("\n"),
    ).toEqual([]);
  });

  it("baseline is not stale — files that improved should have their baseline lowered", () => {
    const improved: string[] = [];
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const n = current[file] ?? 0;
      if (n < allowed) improved.push(`${file}: now ${n}, baseline ${allowed}`);
    }
    // Informational, never blocking: lowering the baseline is a nicety, not a gate.
    if (improved.length) {
      // eslint-disable-next-line no-console
      console.info("[ratchet] baseline can be lowered for:\n  " + improved.join("\n  "));
    }
    expect(true).toBe(true);
  });
});
