import { useRef } from "react";
import { gsap, useScrubScene } from "@/viz/useStoryScroll";
import { EngineCore } from "@/components/algorithm/EngineCore";
import { stageLabel, type PipelineStageKey } from "@/viz/pipelineModel";
import { isResearchRunAllowed } from "@/data/providers";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * Chapter 1 - the establishing shot. Every input pathway in the real pipeline
 * converges into the catalyst-spark engine; the three feeds exit below.
 * Packets loop continuously so the machine reads as alive before you scroll.
 */

interface HeroSource {
  id: string;
  label: string;
  /** Horizontal position in the 1200-unit stage space. */
  x: number;
  /** 0 = upper tier, 1 = lower tier - staggered so labels never collide. */
  tier: 0 | 1;
  /** True when the feed needs an API key (the rest are free/keyless). */
  keyed: boolean;
}

// The real input layer: the discovery agent + anchors, then the live enrichment
// lanes (see SOURCE_LANES in pipelineModel.ts) - Alpaca, Finnhub, FMP, the news
// wire, SEC EDGAR, social, and Congress. Labels are the engine's real source
// short-names; `keyed` mirrors which feeds need a key. The diagram must agree
// with the FinePrint inventory, so FMP rides here and Yahoo (a device-local
// FALLBACK, not a primary live feed) is intentionally NOT a hero source.
// x's are evenly spread and inset from the edges; tiers alternate so adjacent
// chips sit on different rows and can never overlap at any width.
const HERO_SOURCES: HeroSource[] = [
  { id: "agent", label: "Research agent", x: 120, tier: 0, keyed: true },
  { id: "anchors", label: "Niche anchors", x: 240, tier: 1, keyed: false },
  // Prices/momentum come off real Alpaca daily bars in the live broad scan
  // (Yahoo is only the device-local fallback) - matches SOURCE_LANES + BROAD_SCAN
  // in pipelineModel.ts and the enrichment scene. Alpaca is a keyed feed.
  { id: "prices", label: "Alpaca", x: 360, tier: 0, keyed: true },
  { id: "fundamentals", label: "Finnhub", x: 480, tier: 1, keyed: true },
  { id: "fmp", label: "FMP", x: 600, tier: 0, keyed: true },
  { id: "news", label: "News wire", x: 720, tier: 1, keyed: true },
  { id: "sec", label: "SEC EDGAR", x: 840, tier: 0, keyed: false },
  { id: "social", label: "StockTwits", x: 960, tier: 1, keyed: false },
  { id: "congress", label: "Congress", x: 1080, tier: 0, keyed: false },
];

/** Tier y in the 700-unit stage space (where each chip + its wire begin). */
const TIER_Y = [78, 138] as const;

const FEED_OUTS = [
  { id: "today", label: "Today", x: 420 },
  { id: "weekly", label: "Weekly", x: 600 },
  { id: "for-you", label: "For You", x: 780 },
];

const CX = 600;
const CY = 408;

// Tier-0 chips start higher, so their wires descend to a deeper manifold before
// sweeping inward - that keeps an outer tier-0 wire (e.g. Research agent) from
// cutting across the tier-1 chip just below it (Niche anchors). Both control
// depths stay above the inward control point so the curve never kinks.
const C1_DEPTH = [256, 224] as const;

function inPath(x: number, y: number, tier: 0 | 1): string {
  return `M ${x} ${y} C ${x} ${C1_DEPTH[tier]}, ${CX + (x - CX) * 0.22} ${CY - 150}, ${CX} ${CY - 92}`;
}

function outPath(x: number): string {
  return `M ${CX} ${CY + 92} C ${CX} ${CY + 150}, ${x} 620, ${x} 668`;
}

export function SceneHero({
  scroller,
  data,
  onRunLive,
}: {
  scroller: HTMLElement | null;
  data: StoryData;
  /** Engages the guided auto-scroll tour alongside the real run. */
  onRunLive?: () => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const loopsRef = useRef<gsap.core.Tween[]>([]);
  const configured = isResearchRunAllowed();

  const runningStage: PipelineStageKey | undefined = data.currentRun?.stages.find(
    (s) => s.status === "running",
  )?.key as PipelineStageKey | undefined;

  useScrubScene(
    scroller,
    ref,
    (tl, q) => {
      loopsRef.current = [];

      // The wires' one-shot entrance is CSS (see the .hero-wire keyframe); the
      // chips + feed labels carry no opacity animation in CSS or gsap, so they
      // simply rest at full opacity. Keeping opacity out of this scrubbed
      // timeline means a refresh mid-scroll can never freeze them half-faded.

      // Looping packets along every input wire - the machine breathes. Held
      // in loopsRef and paused whenever the scene is offscreen (onToggle), so
      // they never tick while you read the chapters below.
      const launchPacket = (
        packet: SVGCircleElement,
        path: SVGPathElement,
        duration: number,
        delay: number,
      ) => {
        gsap.set(packet, { opacity: 0 });
        loopsRef.current.push(
          gsap.to(packet, {
            motionPath: { path, align: path, alignOrigin: [0.5, 0.5] },
            duration,
            delay,
            repeat: -1,
            ease: "none",
            onStart: () => gsap.set(packet, { opacity: 0.95 }),
          }),
        );
      };
      (q(".hero-wire--in") as SVGPathElement[]).forEach((path, i) => {
        const packet = (q(`.hero-packet--in-${i}`) as SVGCircleElement[])[0];
        if (packet) launchPacket(packet, path, 2.6, i * 0.33);
      });
      (q(".hero-wire--out") as SVGPathElement[]).forEach((path, i) => {
        const packet = (q(`.hero-packet--out-${i}`) as SVGCircleElement[])[0];
        if (packet) launchPacket(packet, path, 2.2, 1.1 + i * 0.45);
      });

      // The hero is the establishing shot. As you scroll past it the title lifts
      // away and the whole machine eases INWARD toward the engine core
      // (transform-origin pinned on the core), so the data sources and the
      // Today / Weekly / For You feeds CONVERGE into the engine. Two things this
      // buys us:
      //  1. Every element only ever moves inward, so the full APIs → engine →
      //     feeds flow stays on-screen and fully legible at EVERY scroll position
      // - it can never scale/translate past the stage's `overflow:hidden`
      //     clip (the old push-in scaled UP + nudged down and cut the feeds off).
      //  2. Converging pulls the bottom feeds UP toward centre, opening clear air
      //     beneath them before the next (Discovery) scene scrolls up - so the
      //     two stacked scenes meet cleanly instead of crowding.
      //
      // Critically: NO opacity fade. The feeds are never dimmed or singled out,
      // so there is no scroll position where they read as ghosted/incomplete
      // (the reported bug was the old timeline leaving them stuck at ~0.15). A
      // scroll-position-driven crossfade would just move that ghost - stop
      // mid-transition and you'd freeze a half-faded diagram - so the diagram
      // stays fully opaque and simply scrolls away under its own power.
      gsap.set(q(".hero-stagewrap"), {
        transformOrigin: `50% ${((CY / 700) * 100).toFixed(3)}%`,
      });
      tl.to(q(".hero-copy"), { opacity: 0, y: -44, duration: 0.4 }, 0)
        .to(q(".hero-cue"), { opacity: 0, duration: 0.2 }, 0)
        .to(q(".hero-stagewrap"), { scale: 0.8, duration: 1 }, 0);
    },
    {
      end: "+=95%",
      scrub: 0.5,
      onToggle: (active) => {
        loopsRef.current.forEach((t) => (active ? t.play() : t.pause()));
        // Also rest the core's CSS ring/halo animations while offscreen.
        ref.current?.classList.toggle("algo-scene--asleep", !active);
      },
    },
  );

  return (
    <section ref={ref} className="algo-scene algo-scene--hero" id="algo-hero">
      <div className="algo-scene__stage">
        <div className="hero-copy">
          <p className="algo-eyebrow">The algorithm</p>
          <h1 className="hero-title">
            Watch how a <span className="gradient-text">signal</span> is made
          </h1>
          <p className="hero-sub">
            Every score in this app comes off this assembly line — AI finds the
            names, live data feeds the evidence, and a transparent engine does
            the math. No black box.
          </p>
          <div className="hero-actions">
            {data.isRunning ? (
              <span className="algo-live-pill" role="status">
                <span className="algo-live-pill__dot" />
                LIVE — {runningStage ? stageLabel(runningStage) : "running"}
              </span>
            ) : configured ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  void data.runResearchNow("manual");
                  onRunLive?.();
                }}
              >
                Run it live
              </button>
            ) : null}
          </div>
        </div>

        <div className="hero-stagewrap">
          <svg
            className="hero-svg"
            viewBox="0 0 1200 700"
            preserveAspectRatio="xMidYMid meet"
          >
            {HERO_SOURCES.map((s) => (
              <path key={s.id} className="hero-wire hero-wire--in" d={inPath(s.x, TIER_Y[s.tier], s.tier)} />
            ))}
            {FEED_OUTS.map((f) => (
              <path key={f.id} className="hero-wire hero-wire--out" d={outPath(f.x)} />
            ))}
            {HERO_SOURCES.map((_, i) => (
              <circle key={i} className={`hero-packet hero-packet--in-${i}`} r="4" />
            ))}
            {FEED_OUTS.map((_, i) => (
              <circle key={i} className={`hero-packet hero-packet--out hero-packet--out-${i}`} r="4" />
            ))}
          </svg>

          <div className="hero-nodes">
            <p className="hero-sources-label mono" aria-hidden="true">
              Data sources — keyed feeds into the engine
            </p>
            {HERO_SOURCES.map((s) => (
              <span
                key={s.id}
                className={`hero-node hero-node--t${s.tier}${s.keyed ? " hero-node--keyed" : ""}`}
                style={{ left: `${(s.x / 1200) * 100}%`, top: `${(TIER_Y[s.tier] / 700) * 100}%` }}
                title={s.keyed ? "Keyed feed (needs an API key)" : "Free / keyless feed"}
              >
                <span className="hero-node__dot" aria-hidden="true" />
                {s.label}
              </span>
            ))}
          </div>

          <div className="hero-core">
            <EngineCore size={228} state={data.isRunning ? "live" : "idle"} />
          </div>

          <div className="hero-outs">
            {FEED_OUTS.map((f) => (
              <span
                key={f.id}
                className="hero-out"
                style={{ left: `${(f.x / 1200) * 100}%` }}
              >
                {f.label}
              </span>
            ))}
          </div>
        </div>

        <div className="hero-cue" aria-hidden="true">
          <span className="hero-cue__line" />
          Scroll to follow the data
        </div>
      </div>
    </section>
  );
}
