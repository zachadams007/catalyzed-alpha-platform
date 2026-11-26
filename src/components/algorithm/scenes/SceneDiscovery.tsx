import { useRef } from "react";
import { useScrubScene } from "@/viz/useStoryScroll";
import { BROAD_SCAN, CURATED, DISCOVERY, DISCOVERY_MODE, FUNNEL, stageLabel } from "@/viz/pipelineModel";
import { resolveProviderId } from "@/data/providers";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * Chapter 2 - discovery. Three truthful tellings, chosen by the resolved data
 * provider (pipelineModel.DISCOVERY_MODE):
 *  • CURATED (the default render) - the LIVE story of the scheduled broad scan:
 *    a cloud task sweeps the WHOLE US common-stock list pre-market, Alpaca-snapshots
 *    it, pre-ranks anti-megacap to the top ~N, scores those, and publishes one
 *    shared daily board everyone reads. The vetted curated set is the device-local
 *    FALLBACK only until that scan publishes.
 *  • FUNNEL - an alternative full-market breadth path via a PAID FMP screener:
 *    every listed US common stock priced by a screener sweep, floored on
 *    liquidity/price/size, ranked anti-megacap, budget-derived top-N scored. The
 *    live story only when that provider is actually resolved.
 *  • AGENT - the AI niche-discovery provider: one hosted research agent hunts
 *    under-followed tickers; survivors pass a live-quote gate.
 * Every label and number comes from pipelineModel (real engine constants).
 */

export function SceneDiscovery(props: { scroller: HTMLElement | null; data: StoryData }) {
  if (DISCOVERY_MODE === "funnel") return <FunnelDiscovery {...props} />;
  if (DISCOVERY_MODE === "agent") return <AgentDiscovery {...props} />;
  return <CuratedDiscovery {...props} />;
}

// Real anchor tickers used as the example stream (constants in realUniverse.ts).
const EXAMPLE_TICKERS = ["IONQ", "RKLB", "ACHR", "CRSP", "SOUN"];

function AgentDiscovery({
  scroller,
  data,
}: {
  scroller: HTMLElement | null;
  data: StoryData;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const liveDetail = data.liveStages.ingest?.status === "running"
    ? data.liveStages.ingest.detail
    : undefined;

  // The agent layer only runs under the discovery provider; with only e.g. a
  // Finnhub key the engine scores the curated live universe instead - say so.
  const discoveryActive = resolveProviderId() === "discovery";
  const counterTarget =
    data.universeSize > 0 ? data.universeSize : DISCOVERY.maxUniverse;

  useScrubScene(
    scroller,
    ref,
    (tl, q) => {
      const counter = { value: 0 };
      const counterEl = (q(".disc-counter__value") as HTMLElement[])[0];
      // Resting DOM shows the final number; the scrub rewinds and counts up.
      if (counterEl) counterEl.textContent = "0";

      tl.from(q(".disc-board"), { opacity: 0, x: -36, duration: 0.5 }, 0)
        .from(
          q(".disc-mission"),
          { opacity: 0, y: 10, stagger: 0.035, duration: 0.3 },
          0.1,
        )
        .to(
          q(".disc-mission--active"),
          { "--mission-glow": 1, duration: 0.4 } as gsap.TweenVars,
          0.55,
        )
        .from(q(".disc-agent"), { opacity: 0, scale: 0.92, duration: 0.5 }, 0.45)
        .from(q(".disc-agent__pulse"), { opacity: 0, duration: 0.3 }, 0.65)
        .from(
          q(".disc-chip"),
          { opacity: 0, x: -60, stagger: 0.09, duration: 0.45 },
          0.9,
        )
        .from(q(".disc-gate"), { opacity: 0, y: 16, duration: 0.4 }, 0.85)
        .to(
          q(".disc-chip--pass"),
          { borderColor: "rgba(26, 178, 232, 0.65)", stagger: 0.07, duration: 0.3 },
          1.35,
        )
        .to(
          q(".disc-chip--drop"),
          { opacity: 0.25, y: 42, rotate: 8, duration: 0.5 },
          1.45,
        )
        .from(q(".disc-drop-note"), { opacity: 0, duration: 0.3 }, 1.55)
        .from(q(".disc-universe"), { opacity: 0, x: 36, duration: 0.5 }, 1.3)
        .to(
          counter,
          {
            value: counterTarget,
            duration: 0.9,
            ease: "power2.out",
            onUpdate: () => {
              if (counterEl) counterEl.textContent = String(Math.round(counter.value));
            },
          },
          1.5,
        )
        .from(q(".disc-anchors"), { opacity: 0, y: 12, duration: 0.4 }, 1.7)
        .from(q(".disc-facts"), { opacity: 0, y: 14, duration: 0.4 }, 1.95);
    },
    { end: "+=200%" },
    [counterTarget],
  );

  return (
    <section ref={ref} className="algo-scene algo-scene--discovery" id="algo-discovery">
      <div className="algo-scene__stage">
        <header className="algo-scene__head">
          <p className="algo-eyebrow">
            Discovery · inside “{stageLabel("ingest")}”
          </p>
          <h2 className="algo-headline">One AI agent hunts the niche</h2>
          <p className="algo-dek">
            It’s <strong>one</strong> hosted research agent — not a swarm —
            handed {DISCOVERY.missionsPerRefresh} rotating theme briefs each
            refresh (from a deck of {DISCOVERY.missionCount}) and sent to live
            web search for real, under-followed U.S. tickers.{" "}
            <em>One agent, several briefs:</em> it suggests what to look at; it
            never scores, ranks, or advises.
          </p>
          {liveDetail ? (
            <p className="algo-live-line mono" role="status">▸ {liveDetail}</p>
          ) : null}
          {!discoveryActive ? (
            <p className="algo-live-line algo-live-line--warn mono" role="note">
              ▸ niche discovery is off (no research proxy) — this run scored the
              curated live universe{data.universeSize > 0 ? ` of ${data.universeSize} names` : ""}
            </p>
          ) : null}
        </header>

        <div className="disc-grid">
          <div className="disc-board" role="list" aria-label="Theme brief deck">
            <p className="disc-board__title">
              Brief deck · <span className="mono">{DISCOVERY.missionsPerRefresh}</span> of{" "}
              <span className="mono">{DISCOVERY.missionCount}</span> active
            </p>
            <p className="disc-board__hint">
              The {DISCOVERY.missionsPerRefresh} lit briefs are what the agent
              works this refresh; the rest wait their turn in the rotation.
            </p>
            {DISCOVERY.missionLabels.map((label, i) => (
              <div
                key={label}
                role="listitem"
                className={`disc-mission${i < DISCOVERY.missionsPerRefresh ? " disc-mission--active" : ""}`}
              >
                <span className="disc-mission__dot" />
                {label}
                {i < DISCOVERY.missionsPerRefresh ? (
                  <span className="disc-mission__tag">active brief</span>
                ) : null}
              </div>
            ))}
          </div>

          <div className="disc-center">
            <div className="disc-agent">
              <span className="disc-agent__pulse" />
              <span className="disc-agent__badge mono">
                1 agent · {DISCOVERY.missionsPerRefresh} briefs in hand
              </span>
              <span className="disc-agent__glyph" aria-hidden="true" />
              <p className="disc-agent__name">Hosted research agent</p>
              <p className="disc-agent__sub">live web search · deep research · proxy-keyed</p>
            </div>

            <div className="disc-stream" aria-hidden="true">
              {EXAMPLE_TICKERS.map((t) => (
                <span key={t} className="disc-chip disc-chip--pass mono">
                  {t}
                </span>
              ))}
              <span className="disc-chip disc-chip--drop mono">····</span>
            </div>

            <div className="disc-gate">
              <p className="disc-gate__label">Finnhub live-quote gate</p>
              <p className="disc-gate__rule">{DISCOVERY.validationGate}</p>
              <p className="disc-drop-note">no live quote → skipped silently</p>
            </div>
          </div>

          <div className="disc-universe">
            <p className="disc-counter__label">
              Scored universe{data.universeSize > 0 ? " · last run" : ""}
            </p>
            <p className="disc-counter">
              <span className="disc-counter__value mono">{counterTarget}</span>
              {discoveryActive ? (
                <span className="disc-counter__cap mono">/ {DISCOVERY.maxUniverse} cap</span>
              ) : null}
            </p>
            <p className="disc-anchors">
              + {DISCOVERY.anchorTickers.length} niche anchors backfill for
              stable coverage — mega-caps excluded from the anchor set
            </p>
          </div>
        </div>

        <ul className="disc-facts" aria-label="Discovery guardrails">
          <li>{DISCOVERY.missionsPerRefresh} missions / refresh</li>
          <li>{DISCOVERY.cacheTtlMinutes}-min cache</li>
          <li>{DISCOVERY.failureCooldownMinutes}-min failure cooldown</li>
          <li>≤ {DISCOVERY.maxDiscoveredPerRefresh} tickers / refresh</li>
          <li>regex-validated symbols</li>
          <li>no buy/sell advice — ever</li>
        </ul>
      </div>
    </section>
  );
}

// Example real names shown surviving the pre-rank into the scored top-N - a
// mix of large-cap and high-volatility small/mid names to make the
// "anti-megacap, every sector" tilt concrete.
const CURATED_EXAMPLE = ["NVDA", "PLTR", "IONQ", "RKLB", "SOUN"];

function CuratedDiscovery({
  scroller,
  data,
}: {
  scroller: HTMLElement | null;
  data: StoryData;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const liveDetail =
    data.discoverySummary ??
    (data.liveStages.ingest?.status === "running" ? data.liveStages.ingest.detail : undefined);
  // The "Scored universe" counter shows the published top-N (signalCount on a real
  // run), falling back to the scan's top-N target.
  const counterTarget = data.signalCount > 0 ? data.signalCount : BROAD_SCAN.targetN;

  useScrubScene(
    scroller,
    ref,
    (tl, q) => {
      const counter = { value: 0 };
      const counterEl = (q(".disc-counter__value") as HTMLElement[])[0];
      if (counterEl) counterEl.textContent = "0";

      tl.from(q(".disc-board"), { opacity: 0, x: -36, duration: 0.5 }, 0)
        .from(q(".disc-mission"), { opacity: 0, y: 10, stagger: 0.06, duration: 0.32 }, 0.1)
        .from(q(".disc-agent"), { opacity: 0, scale: 0.92, duration: 0.5 }, 0.45)
        .from(q(".disc-agent__pulse"), { opacity: 0, duration: 0.3 }, 0.65)
        .from(q(".disc-chip"), { opacity: 0, x: -60, stagger: 0.09, duration: 0.45 }, 0.9)
        .to(
          q(".disc-chip--pass"),
          { borderColor: "rgba(26, 178, 232, 0.65)", stagger: 0.07, duration: 0.3 },
          1.35,
        )
        .from(q(".disc-gate"), { opacity: 0, y: 16, duration: 0.4 }, 0.85)
        .from(q(".disc-universe"), { opacity: 0, x: 36, duration: 0.5 }, 1.3)
        .to(
          counter,
          {
            value: counterTarget,
            duration: 0.9,
            ease: "power2.out",
            onUpdate: () => {
              if (counterEl) counterEl.textContent = String(Math.round(counter.value));
            },
          },
          1.5,
        )
        .from(q(".disc-anchors"), { opacity: 0, y: 12, duration: 0.4 }, 1.7)
        .from(q(".disc-facts"), { opacity: 0, y: 14, duration: 0.4 }, 1.95);
    },
    { end: "+=200%" },
    [counterTarget],
  );

  const capLabel = (n: number) => `$${Math.round(n / 1_000_000)}M`;

  return (
    <section ref={ref} className="algo-scene algo-scene--discovery" id="algo-discovery">
      <div className="algo-scene__stage">
        <header className="algo-scene__head">
          <p className="algo-eyebrow">
            Discovery · inside “{stageLabel("ingest")}”
          </p>
          <h2 className="algo-headline">The whole US market, scanned once a day</h2>
          <p className="algo-dek">
            No fixed list. A scheduled cloud scan starts pre-market from{" "}
            <strong>every listed U.S. common stock</strong>, bulk-snapshots them in
            one pass, then a pre-rank applies hard price + liquidity floors and{" "}
            <em>ranks anti-megacap</em> — the top{" "}
            <strong>~{BROAD_SCAN.targetN}</strong> get fully scored through the
            identical 0–100 engine.
          </p>
          {liveDetail ? (
            <p className="algo-live-line mono" role="status">▸ {liveDetail}</p>
          ) : null}
          <p className="algo-live-line mono" role="note">
            ▸ one shared daily board — the scan publishes to a cache everyone reads,
            so testers spend zero extra API calls
          </p>
          <p className="algo-live-line mono" role="note">
            ▸ catalyst-discovery engine — the reason it’s called Catalyzed: before
            pre-ranking, the scan harvests market-wide catalysts (fresh 8-K filings,
            open-market insider buys, activist 13D stakes) and SEEDS those names —
            especially smaller caps — onto the board, so a real catalyst can surface a
            name that wouldn’t clear the liquidity floor on its own
          </p>
        </header>

        <div className="disc-grid">
          <div className="disc-board" role="list" aria-label="Broad-scan inputs">
            <p className="disc-board__title">Stage 0 · the full market</p>
            <p className="disc-board__hint">
              No hardcoded list — the universe is the market, swept daily.
            </p>
            <div role="listitem" className="disc-mission disc-mission--active">
              <span className="disc-mission__dot" />
              Every listed U.S. common stock
              <span className="disc-mission__tag">source</span>
            </div>
            <div role="listitem" className="disc-mission">
              <span className="disc-mission__dot" />
              {BROAD_SCAN.universeSource}
            </div>
            <div role="listitem" className="disc-mission">
              <span className="disc-mission__dot" />
              {BROAD_SCAN.snapshotSource}
            </div>
            <div role="listitem" className="disc-mission">
              <span className="disc-mission__dot" />
              {BROAD_SCAN.momentumSource}
            </div>
            <div role="listitem" className="disc-mission">
              <span className="disc-mission__dot" />
              {BROAD_SCAN.smartMoneySource}
            </div>
          </div>

          <div className="disc-center">
            <div className="disc-agent">
              <span className="disc-agent__pulse" />
              <span className="disc-agent__badge mono">pre-rank · anti-megacap</span>
              <span className="disc-agent__glyph" aria-hidden="true" />
              <p className="disc-agent__name">Cross-sectional pre-rank</p>
              <p className="disc-agent__sub">
                ≥${BROAD_SCAN.minPrice} · {capLabel(BROAD_SCAN.minDollarVolume)}+ daily $ vol · vol + day-move tilt
              </p>
            </div>

            <div className="disc-stream" aria-hidden="true">
              {CURATED_EXAMPLE.map((t) => (
                <span key={t} className="disc-chip disc-chip--pass mono">
                  {t}
                </span>
              ))}
              <span className="disc-chip disc-chip--drop mono">illiquid ····</span>
            </div>

            <div className="disc-gate">
              <p className="disc-gate__label">Same engine, every survivor</p>
              <p className="disc-gate__rule">{BROAD_SCAN.guardrail}</p>
            </div>
          </div>

          <div className="disc-universe">
            <p className="disc-counter__label">
              Scored & published{data.signalCount > 0 ? " · last run" : ""}
            </p>
            <p className="disc-counter">
              <span className="disc-counter__value mono">{counterTarget}</span>
              <span className="disc-counter__cap mono">/ ~{BROAD_SCAN.targetN} target</span>
            </p>
            <p className="disc-anchors">
              The vetted {CURATED.size}-name set rides along as guaranteed seeds — and
              is the device-local fallback until the scan publishes
            </p>
          </div>
        </div>

        <ul className="disc-facts" aria-label="Broad-scan guardrails">
          <li>whole US market swept daily</li>
          <li>≥${BROAD_SCAN.minPrice} · {capLabel(BROAD_SCAN.minDollarVolume)}+ daily volume</li>
          <li>anti-megacap pre-rank</li>
          <li>real Alpaca-bars momentum vs SPY</li>
          <li>top ~{BROAD_SCAN.targetN} fully scored</li>
          <li>one shared daily board</li>
          <li>no buy/sell advice — ever</li>
        </ul>
      </div>
    </section>
  );
}

// Floor-gate chips shown flowing through the pre-filter (labels mirror FUNNEL.gates).
const GATE_CHIPS = ["price > $5", "$1M+ ADV", "$50M+ cap", "common stock"];

function FunnelDiscovery({
  scroller,
  data,
}: {
  scroller: HTMLElement | null;
  data: StoryData;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const funnelActive = resolveProviderId() === "funnel";
  const liveDetail =
    data.discoverySummary ??
    (data.liveStages.ingest?.status === "running" ? data.liveStages.ingest.detail : undefined);
  const counterTarget = data.universeSize > 0 ? data.universeSize : FUNNEL.targetMax;
  const capLabel = (n: number) => `$${Math.round(n / 1_000_000)}M`;

  useScrubScene(
    scroller,
    ref,
    (tl, q) => {
      const counter = { value: 0 };
      const counterEl = (q(".disc-counter__value") as HTMLElement[])[0];
      if (counterEl) counterEl.textContent = "0";

      tl.from(q(".disc-board"), { opacity: 0, x: -36, duration: 0.5 }, 0)
        .from(q(".disc-mission"), { opacity: 0, y: 10, stagger: 0.06, duration: 0.32 }, 0.1)
        .from(q(".disc-agent"), { opacity: 0, scale: 0.92, duration: 0.5 }, 0.45)
        .from(q(".disc-agent__pulse"), { opacity: 0, duration: 0.3 }, 0.65)
        .from(q(".disc-chip"), { opacity: 0, x: -60, stagger: 0.09, duration: 0.45 }, 0.9)
        .from(q(".disc-gate"), { opacity: 0, y: 16, duration: 0.4 }, 0.85)
        .to(
          q(".disc-chip--pass"),
          { borderColor: "rgba(26, 178, 232, 0.65)", stagger: 0.07, duration: 0.3 },
          1.35,
        )
        .to(q(".disc-chip--drop"), { opacity: 0.25, y: 42, rotate: 8, duration: 0.5 }, 1.45)
        .from(q(".disc-drop-note"), { opacity: 0, duration: 0.3 }, 1.55)
        .from(q(".disc-universe"), { opacity: 0, x: 36, duration: 0.5 }, 1.3)
        .to(
          counter,
          {
            value: counterTarget,
            duration: 0.9,
            ease: "power2.out",
            onUpdate: () => {
              if (counterEl) counterEl.textContent = String(Math.round(counter.value));
            },
          },
          1.5,
        )
        .from(q(".disc-anchors"), { opacity: 0, y: 12, duration: 0.4 }, 1.7)
        .from(q(".disc-facts"), { opacity: 0, y: 14, duration: 0.4 }, 1.95);
    },
    { end: "+=200%" },
    [counterTarget],
  );

  return (
    <section ref={ref} className="algo-scene algo-scene--discovery" id="algo-discovery">
      <div className="algo-scene__stage">
        <header className="algo-scene__head">
          <p className="algo-eyebrow">
            Discovery · inside “{stageLabel("ingest")}”
          </p>
          <h2 className="algo-headline">The whole market, funneled</h2>
          <p className="algo-dek">
            No fixed list. Each run starts from <strong>every listed U.S. common
            stock</strong>, prices them with one broad screener sweep, then
            applies hard liquidity, price, and size floors.{" "}
            <em>Survivors rank with a small/mid, anti-megacap tilt</em> — and the
            budget-derived top {FUNNEL.targetMax} get hydrated and scored.
          </p>
          {liveDetail ? (
            <p className="algo-live-line mono" role="status">▸ {liveDetail}</p>
          ) : null}
          {!funnelActive ? (
            <p className="algo-live-line algo-live-line--warn mono" role="note">
              ▸ full-market funnel needs an FMP key — this run scored the
              configured live universe{data.universeSize > 0 ? ` of ${data.universeSize} names` : ""}
            </p>
          ) : null}
        </header>

        <div className="disc-grid">
          <div className="disc-board" role="list" aria-label="Funnel inputs">
            <p className="disc-board__title">Stage 0 · the full market</p>
            <p className="disc-board__hint">
              No hardcoded list — the universe is the market, refreshed daily.
            </p>
            <div role="listitem" className="disc-mission disc-mission--active">
              <span className="disc-mission__dot" />
              Every listed U.S. common stock
              <span className="disc-mission__tag">source</span>
            </div>
            <div role="listitem" className="disc-mission">
              <span className="disc-mission__dot" />
              {FUNNEL.symbolListSource}
            </div>
            <div role="listitem" className="disc-mission">
              <span className="disc-mission__dot" />
              {FUNNEL.sweepSource}
            </div>
          </div>

          <div className="disc-center">
            <div className="disc-agent">
              <span className="disc-agent__pulse" />
              <span className="disc-agent__badge mono">floor gates</span>
              <span className="disc-agent__glyph" aria-hidden="true" />
              <p className="disc-agent__name">Pre-filter</p>
              <p className="disc-agent__sub">{FUNNEL.gateSummary}</p>
            </div>

            <div className="disc-stream" aria-hidden="true">
              {GATE_CHIPS.map((label) => (
                <span key={label} className="disc-chip disc-chip--pass mono">
                  {label}
                </span>
              ))}
              <span className="disc-chip disc-chip--drop mono">illiquid ····</span>
            </div>

            <div className="disc-gate">
              <p className="disc-gate__label">Anti-megacap rank</p>
              <p className="disc-gate__rule">{FUNNEL.rankSummary}</p>
              <p className="disc-drop-note">below the floor → dropped</p>
            </div>
          </div>

          <div className="disc-universe">
            <p className="disc-counter__label">
              Scored universe{data.universeSize > 0 ? " · last run" : ""}
            </p>
            <p className="disc-counter">
              <span className="disc-counter__value mono">{counterTarget}</span>
              <span className="disc-counter__cap mono">/ {FUNNEL.targetMax} target</span>
            </p>
            <p className="disc-anchors">{FUNNEL.budgetNote}</p>
          </div>
        </div>

        <ul className="disc-facts" aria-label="Funnel guardrails">
          <li>full-market funnel</li>
          <li>price &gt; ${FUNNEL.gates.minPrice}</li>
          <li>{capLabel(FUNNEL.gates.minDollarVolume)}+ daily volume</li>
          <li>{capLabel(FUNNEL.gates.minMarketCap)}+ cap floor</li>
          <li>budget-capped top-{FUNNEL.targetMax}</li>
          <li>blended modes: wide-net · overlooked · learn-winners · themes</li>
          <li>megacaps never auto-win</li>
          <li>no buy/sell advice — ever</li>
        </ul>
      </div>
    </section>
  );
}
