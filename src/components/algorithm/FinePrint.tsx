import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import {
  AI_LANE,
  AI_PICK_SOURCES,
  BROAD_SCAN,
  CATEGORY_CONFIG,
  CHALLENGER_CATALYST_BLEND,
  CHALLENGER_REFINEMENTS,
  CHALLENGER_REFINEMENT_COUNT_WORD,
  CONFIDENCE,
  CURATED,
  DISCOVERY_MODE,
  ENGINE_LINEAGE,
  FUNNEL,
  LIVE_PRICE,
  NORMALIZATION,
  RISK,
  RISK_COMPONENT_LABELS,
  SOURCE_LANES,
  V4_ARCHETYPE_EXPLANATION,
  V4_FALSE_POSITIVE_SCREENS,
  V4_IS_LIVE,
  V4_REGIME_TILT,
  lineageIdForVariant,
} from "@/viz/pipelineModel";
import { formatPctPlain } from "@/lib/format";
import { useActiveVariant } from "@/hooks/useActiveVariant";
import {
  isFinnhubConfigured,
  isResearchProxyConfigured,
} from "@/data/http";
import { runsCatalystDrivenProfile } from "@/engine/challenger";

/** Plain-English label for each risk component, paired with its max subtraction. */
const RISK_COMPONENT_BLURBS: Record<keyof typeof RISK.components, string> = {
  solvency: "Can it fund itself? Weak balance sheet → points off.",
  dilution: "Is it printing shares? Chronic dilution → points off.",
  shortInterest: "Crowded short? Squeeze cuts both ways → points off.",
  governance: "Red flags in how it’s run → points off.",
  extremeVol: "Wild, untradeable swings → points off.",
  pumpRisk: "No revenue + thin float + promo hype + insider selling → demoted, never zeroed.",
  extension: "Already ran far above its base — asymmetry gone → points off, softened by a fresh catalyst.",
};

/**
 * The fine print under the story - the trust layer. Weight table, risk &
 * confidence models, and source inventory all render the engine's own
 * configuration, so this section cannot drift from the code.
 */
export function FinePrint() {
  const discoveryLive = isResearchProxyConfigured() && isFinnhubConfigured();
  // The cap-balanced cross-sectional re-score is UNIVERSAL - both engine models
  // run it (see the always-on "Cap-balanced re-score" card and NORMALIZATION).
  // The soft thesis gate + the LANE-D catalyst/discount blend + the time-aware
  // signals (EWMA news/social + estimate-revision) belong to the CATALYST-DRIVEN
  // profile, which is the promoted live Champion. We gate just that card on
  // whether the live model runs that profile, so the copy never over-promises the
  // catalyst features when the curated-base shadow is live, but always gets credit
  // for the cap-balancing.
  const catalystDrivenScoring = runsCatalystDrivenProfile();
  const liveEngineVersionId = lineageIdForVariant(useActiveVariant());

  return (
    <section className="algo-fineprint" id="algo-fineprint">
      <div className="algo-fineprint__inner">
        <header className="algo-fineprint__head">
          <p className="algo-eyebrow">The fine print</p>
          <h2 className="algo-headline algo-headline--sm">
            Rendered from the engine’s own config
          </h2>
          <p className="algo-dek">
            Everything above is generated from the same configuration the
            engine runs — when the code changes, this page changes.
          </p>
        </header>

        {/* Engine version lineage - so you can verify which engine is live. */}
        <section className="engine-lineage" aria-label="Engine version lineage">
          <header className="engine-lineage__head">
            <h3 className="engine-lineage__title">Which engine is live</h3>
            <p className="engine-lineage__sub">
              The scoring engine has shipped four generations.{" "}
              {liveEngineVersionId ? (
                <>
                  <strong>{liveEngineVersionId} is live right now</strong> - the promoted Champion
                  ranking the published feed.
                </>
              ) : (
                <>
                  The curated-base <strong>shadow</strong> model is live right
                  now; v4 is the promoted Champion.
                </>
              )}
            </p>
          </header>
          <ol className="engine-lineage__track">
            {ENGINE_LINEAGE.map((v, i) => {
              const isLive = v.id === liveEngineVersionId;
              return (
                <li
                  key={v.id}
                  className={`engine-ver${isLive ? " engine-ver--live" : ""}`}
                  aria-current={isLive ? "true" : undefined}
                >
                  <div className="engine-ver__top">
                    <span className="engine-ver__id mono">{v.id}</span>
                    {isLive ? (
                      <span className="engine-ver__badge" role="status">
                        <span className="engine-ver__dot" aria-hidden="true" />
                        LIVE
                      </span>
                    ) : (
                      <span className="engine-ver__badge engine-ver__badge--past">
                        {v.id === "v4" ? "Champion" : "superseded"}
                      </span>
                    )}
                  </div>
                  <p className="engine-ver__name">{v.name}</p>
                  <p className="engine-ver__internal mono">{v.internalName}</p>
                  <p className="engine-ver__summary">{v.summary}</p>
                  <ul className="engine-ver__highlights">
                    {v.highlights.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                  {i < ENGINE_LINEAGE.length - 1 ? (
                    <span className="engine-ver__arrow" aria-hidden="true">→</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <p className="engine-lineage__foot">
            “Challenger” means the curated-base{" "}
            <strong>shadow</strong> model — a comparison baseline the rank-IC loop
            measures the live engine against. It does <strong>not</strong> rank
            your feed.
          </p>
        </section>

        {/* The single AI-lane boundary - stated once, prominently. */}
        <section className="ai-lane" aria-label="Where AI is and isn’t used">
          <p className="ai-lane__tag mono">The AI boundary — one rule</p>
          <p className="ai-lane__headline">{AI_LANE.headline}</p>
          <div className="ai-lane__cols">
            <div className="ai-lane__col ai-lane__col--does">
              <p className="ai-lane__col-head">AI does</p>
              <ul>
                {AI_LANE.does.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
            <div className="ai-lane__col ai-lane__col--never">
              <p className="ai-lane__col-head">AI never touches</p>
              <ul>
                {AI_LANE.neverTouches.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <div className="fineprint-grid">
          <article className="fineprint-card">
            <h3 className="fineprint-card__title">The blend — weights sum to 1.0</h3>
            <table className="fineprint-table">
              <tbody>
                {CATEGORY_CONFIG.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    <td className="mono">{formatPctPlain(c.weight, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>

          <article className="fineprint-card fineprint-card--wide">
            <h3 className="fineprint-card__title">Risk &amp; confidence</h3>
            <p>
              <strong>Risk only ever subtracts.</strong> Seven components, capped
              at <span className="mono">{RISK.cap}</span> pts total — each one
              shaves points off a name, none can add:
            </p>
            <ul className="risk-badges" aria-label="The seven risk components">
              {(
                Object.entries(RISK.components) as Array<
                  [keyof typeof RISK.components, { max: number }]
                >
              ).map(([key, c]) => (
                <li key={key} className="risk-badge">
                  <span className="risk-badge__head">
                    <span className="risk-badge__name">
                      {RISK_COMPONENT_LABELS[key]}
                    </span>
                    <span className="risk-badge__max mono">−{c.max}</span>
                  </span>
                  <span className="risk-badge__blurb">
                    {RISK_COMPONENT_BLURBS[key]}
                  </span>
                </li>
              ))}
            </ul>
            <div className="conf-block">
              <p className="conf-block__title">
                Confidence — a separate axis
              </p>
              <p>
                Not how good the setup is, but how much we trust the inputs
                behind it. Missing fields read “N/A”, never fabricated.
              </p>
              <ul className="conf-meta">
                <li>
                  Evidence{" "}
                  <span className="mono">
                    {Math.round(CONFIDENCE.evidenceWeight * 100)}%
                  </span>
                </li>
                <li>
                  Agreement{" "}
                  <span className="mono">
                    {Math.round(CONFIDENCE.agreementWeight * 100)}%
                  </span>
                </li>
                <li>
                  Floor <span className="mono">{CONFIDENCE.floor}</span>
                </li>
              </ul>
              <ul className="conf-penalties" aria-label="What lowers confidence">
                <li>thin news</li>
                <li>conflicting signals</li>
                <li>illiquidity</li>
                <li>weak catalysts</li>
                <li>modeled data</li>
              </ul>
            </div>
          </article>

          <article className="fineprint-card">
            <h3 className="fineprint-card__title">How the universe is sourced</h3>
            {DISCOVERY_MODE === "funnel" ? (
              <p>
                <strong>The funnel sources the universe; nothing AI touches the 0–100 score.</strong>{" "}
                Each run sweeps every listed U.S. common stock, applies hard floors
                ({FUNNEL.gateSummary}), and ranks survivors with an anti-megacap
                tilt — then hydrates and scores the budget-derived top {FUNNEL.targetMax}.
              </p>
            ) : DISCOVERY_MODE === "agent" ? (
              <p>
                <strong>AI sources the universe; AI never touches the 0–100 score.</strong>{" "}
                {discoveryLive
                  ? "Niche discovery is live: AI-found tickers are quote-validated, hydrated, then scored by the deterministic engine."
                  : "Add a research proxy + Finnhub key to turn on niche discovery; until then the feed uses the curated live universe."}
              </p>
            ) : (
              <p>
                <strong>A scheduled scan of the whole US market sources the feed; nothing AI touches the 0–100 score.</strong>{" "}
                Pre-market each U.S. trading day a scheduled cloud job sweeps every
                listed U.S. common stock ({BROAD_SCAN.universeSource}), bulk-snapshots
                them ({BROAD_SCAN.snapshotSource}), then a pure pre-rank applies a
                ≥${BROAD_SCAN.minPrice} price floor + ${Math.round(BROAD_SCAN.minDollarVolume / 1_000_000)}M/day
                liquidity floor and ranks anti-megacap. The top ~{BROAD_SCAN.targetN}
                are enriched with real Alpaca daily bars (momentum vs SPY),
                fundamentals &amp; news, fully scored, and published to the shared
                daily_signals cache — every tester reads that one board with zero
                vendor calls. The vetted {CURATED.size}-name set is the device-local
                fallback only until that scan publishes.
              </p>
            )}
            <p>
              On top of the once-daily score, the displayed price + day-change
              refresh live ({LIVE_PRICE.source}) on the watchlist, feed cards, stock
              detail, and portfolio — on view-open + manual refresh, never polling.
              The opportunity score stays daily and shared; only the price ticks.{" "}
              {LIVE_PRICE.caveat}
            </p>
            <p>
              Scoring and screening are pure, auditable math. The one explicit
              exception is ordering in Blueprint's AI ranking modes: there, Run
              Blueprint asks the research agent for a per-ticker relevance vote,
              and that vote (clearly labeled) re-orders the same scored board.
            </p>
            <p>
              Discovery & research only — no brokerage, no orders, no buy/sell
              advice.
            </p>
          </article>

          <article className="fineprint-card">
            <h3 className="fineprint-card__title">
              Cap-balanced re-score — every model
            </h3>
            <p>
              Before the board splits into feeds, every model re-scores the{" "}
              <em>whole universe at once</em> — not each name in isolation. The
              coverage &amp; volume dimensions ({NORMALIZATION.residualizedDims.join(", ")})
              are residualized against size, so a mega-cap can’t win on the
              headlines and dollar volume it gets simply for being big; the slow
              quality factors ({NORMALIZATION.sectorNeutralDims.join(", ")}) are
              judged against their own sector, not the whole market.
            </p>
            <p>
              A bounded small/mid-cap tilt then rebalances by size —{" "}
              <span className="mono">±{NORMALIZATION.championCapTilt}</span> pts on
              both the live V4 engine and the shadow model — so a catalyzed
              small-cap can out-rank an un-catalyzed mega-cap and Today surfaces a
              real large/mid/small mix. Raw per-dimension scores never move; only
              the ranking key does.
            </p>
            <p>
              The live V4 engine goes one step further: it routes the blend{ " "}
              <em>weights</em> by cap cohort — <strong>three strategies</strong> for
              the three ends of the market. A <em>smaller</em> name (≤ $2B) is judged
              on the curve that actually predicts its runs — revenue growth, a
              building pipeline, an early catalyst and sentiment shift{ " "}
              <em>with substance</em>; a <em>middle</em> name ($2–10B) leads on
              revenue/margin <em>re-acceleration</em>; and a <em>larger</em> name
              ({">"} $10B, large or mega) leans on the margin/profit inflection, entry
              timing and a discounted-quality reversal. An anti-lottery guard demotes
              (never zeroes) pump-tickets — no
              revenue, a thin float, promo-only hype, insider selling, or chronic
              dilution. An extension guard catches names that have already run far
              above their trailing base (the edge is a discounted setup{ " "}
              <em>before</em> the move, not chasing a 6×+ runner), softened when a
              fresh inflection or live catalyst justifies continuation.
            </p>
            {NORMALIZATION.displayFullScale ? (
              <p>
                The published 0–100 score is then spread across the{" "}
                <em>full scale</em> relative to the day’s universe — the strongest
                setups reach ~100, the weakest ~0, with everything in between
                evenly spaced — so the number tells you where a name ranks{" "}
                <em>today</em> instead of the middling 30–50 everything used to
                cluster near. It blends a name’s percentile with its absolute
                score, so a genuinely strong day still lifts the whole board and
                there may be no exact 100. Ordering never changes — only the
                spacing of the numbers.
              </p>
            ) : null}
          </article>

          {catalystDrivenScoring ? (
            <article className="fineprint-card fineprint-card--wide">
              <h3 className="fineprint-card__title">
                What the live V4 engine adds
              </h3>
              <p>
                On top of that universal cap-balanced re-score, the live V4
                engine adds a <strong>soft thesis gate</strong> — it demotes
                (never removes) names that lack both a reason to move and
                something behind it — over the same gentle anti-megacap tilt the
                shadow model uses. Its catalyst and discount tilts (which skew
                small-cap in a discovery universe) are size-balanced against
                market cap, so Today stays an even small/mid/large mix. The gate
                and the discount reward only count a backer the name actually has{" "}
                <em>data</em> for — a cold-start dimension with no inputs can no
                longer read as “backed by a fundamental inflection” it doesn’t have.
              </p>
              <p>
                The discount reward is also{" "}
                <strong>reversal-readiness gated</strong>: a cheap name earns full
                discount points only once its decline has measurably{" "}
                <em>decelerated or based</em> — down-leg deceleration plus
                volatility contraction, read from its own price history — so the
                feed rewards a washed-out setup that is turning, not a knife still
                mid-fall. Being below a moving average is <em>never</em> a penalty
                on its own — that is exactly where a reversal is caught, before the
                move. Only an active crash (deeply oversold <em>and</em> freshly
                down more than ~25% in a month with no live catalyst) forgoes the
                bonus, and a live dated catalyst bypasses the gate entirely. A washout
                that is digesting a <em>fresh adverse event</em> — a sharp
                single-session drop, or fresh strongly-negative news — also has its
                discount reward cut, since the down-move likely isn&apos;t exhausted yet.
              </p>
              <p>
                And &ldquo;discounted&rdquo; means more than just far from its own high:
                the entry read is blended, <strong>cap-aware</strong>, with how cheap
                the stock actually is on fundamentals — a larger cap on its P/E and PEG
                (a low-multiple name reads attractively valued even near its highs), a
                smaller cap on a growth-adjusted EV/Sales that is never punished for the
                weak current earnings a small-cap usually has. When a name has no
                fundamental data, the read falls back to price action unchanged.
              </p>
              {V4_IS_LIVE ? (
                <>
                  <p className="fineprint-subhead">
                    V4 archetype router - winner-study setups, not one flat curve:
                  </p>
                  <ul className="lane-cards" aria-label="V4 archetypes">
                    {V4_ARCHETYPE_EXPLANATION.map((r) => (
                      <li key={r.id} className="lane-card">
                        <p className="lane-card__label">{r.label}</p>
                        <p className="lane-card__detail">
                          {r.setup} {r.engine}
                        </p>
                      </li>
                    ))}
                  </ul>
                  <p className="fineprint-subhead">{V4_REGIME_TILT.label}</p>
                  <p>{V4_REGIME_TILT.detail}</p>
                  <p className="fineprint-subhead">
                    False-positive screens - bounded, additive, and honest about missing data:
                  </p>
                  <ul className="lane-cards" aria-label="V4 false-positive screens">
                    {V4_FALSE_POSITIVE_SCREENS.map((screen) => (
                      <li key={screen} className="lane-card">
                        <p className="lane-card__detail">{screen}</p>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="fineprint-subhead">
                Catalyst-driven blend — the signal that names the app. Moderate,
                clearly-felt, never a gate:
              </p>
              <ul className="lane-cards" aria-label="Catalyst-driven blend">
                {CHALLENGER_CATALYST_BLEND.map((r) => (
                  <li key={r.id} className="lane-card">
                    <p className="lane-card__label">{r.label}</p>
                    <p className="lane-card__detail">{r.detail}</p>
                  </li>
                ))}
              </ul>
              <p className="fineprint-subhead">
                {CHALLENGER_REFINEMENT_COUNT_WORD.charAt(0).toUpperCase() +
                  CHALLENGER_REFINEMENT_COUNT_WORD.slice(1)}{" "}
                time-aware signals — they need history one run can’t see. Each is
                bounded — a tie-breaker, never a driver:
              </p>
              <ul className="lane-cards" aria-label="Time-aware signals">
                {CHALLENGER_REFINEMENTS.map((r) => (
                  <li key={r.id} className="lane-card">
                    <p className="lane-card__label">{r.label}</p>
                    <p className="lane-card__detail">{r.detail}</p>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}

          <article className="fineprint-card fineprint-card--wide">
            <h3 className="fineprint-card__title">Live data sources</h3>
            <p>
              Every number comes from a real market-data provider — each one below, with
              what it fills in. Some providers need an <strong>API key</strong>: a private
              password that lets the app call their service. On the public web app and the
              desktop build those keys live ONLY on our server — a small proxy that makes the
              calls for you — <strong>never in your browser or the app itself</strong>, so they
              can’t leak. Sources tagged <em>keyless</em> are free public endpoints that need
              no key at all.
            </p>
            <ul className="fineprint-sources">
              {SOURCE_LANES.map((lane) => (
                <li key={lane.id}>
                  <span className="fineprint-sources__name">{lane.source}</span>
                  <span className="fineprint-sources__fills">{lane.fills}</span>
                  {lane.keyless ? (
                    <span className="enrich-lane__keyless">keyless</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="fineprint-subhead">
              AI Pick only — language, never the score:
            </p>
            <ul className="fineprint-sources">
              {AI_PICK_SOURCES.map((src) => (
                <li key={src.id}>
                  <span className="fineprint-sources__name">{src.source}</span>
                  <span className="fineprint-sources__fills">{src.fills}</span>
                  <span className="enrich-lane__keyless enrich-lane__keyless--ai">
                    AI · server-side
                  </span>
                </li>
              ))}
            </ul>
          </article>
        </div>

        <InvestingDisclaimer className="page-disclaimer" />
      </div>
    </section>
  );
}
