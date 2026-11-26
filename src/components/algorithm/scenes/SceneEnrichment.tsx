import { useRef } from "react";
import { useScrubScene } from "@/viz/useStoryScroll";
import { SOURCE_LANES, stageLabel } from "@/viz/pipelineModel";
import { formatPct, freshnessLabel } from "@/lib/format";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * Chapter 3 - the signature shot. The six real enrichment lanes fan into one
 * company record in true execution order (Alpaca daily bars → Finnhub → news
 * wire → SEC EDGAR → StockTwits/ApeWisdom → House Stock Watcher). With live
 * signals in the store the card fills with REAL values from the top-ranked name;
 * otherwise it walks a labeled representative example.
 */

interface LaneValue {
  label: string;
  value: string;
  na?: boolean;
}

function laneValues(data: StoryData): Record<string, LaneValue> {
  const s = data.example.signal;
  if (s) {
    const mentions = s.social.redditMentions24h + s.social.xMentions24h;
    const peg = s.fundamentals.pegRatio;
    return {
      prices: {
        label: "Momentum",
        value: `${formatPct(s.momentum.return3M)} 3M · RSI ${Math.round(s.momentum.rsi)}`,
      },
        fundamentals:
        peg == null
          ? { label: "Fundamentals", value: "PEG N/A — stays N/A", na: true }
          : {
              label: "Fundamentals",
              value: `gross margin ${formatPct(s.fundamentals.grossMargin)} · PEG ${peg.toFixed(1)}`,
            },
      news: {
        label: "Catalyst & news",
        value: `${s.news.count7d} stories 7d · ${freshnessLabel(s.news.freshnessHours)}`,
      },
      sec: {
        label: "SEC filings 90d",
        value: s.secActivity
          ? `${s.secActivity.form4Count90d} Form 4 · ${s.secActivity.eightKCount90d} 8-K`
          : "no recent filings",
      },
      social: {
        label: "Attention",
        value: `${mentions} recent mentions`,
      },
      congress: {
        label: "Political",
        value: `${s.social.politicalMentions} disclosed trades`,
      },
    };
  }
  // Representative example - labeled as such in the card header.
  return {
    prices: { label: "Momentum", value: "+18% 3M · RSI 61" },
    fundamentals: { label: "Fundamentals", value: "PEG N/A — stays N/A", na: true },
    news: { label: "Catalyst & news", value: "8 stories 7d · 3h ago" },
    sec: { label: "SEC filings 90d", value: "2 Form 4 · 1 8-K" },
    social: { label: "Attention", value: "412 mentions 24h" },
    congress: { label: "Political", value: "3 disclosed trades" },
  };
}

// Lane geometry in the 1200×660 stage space: 3 lanes per side.
const LANE_POS: Record<string, { side: "l" | "r"; y: number }> = {
  prices: { side: "l", y: 130 },
  fundamentals: { side: "l", y: 330 },
  news: { side: "l", y: 530 },
  sec: { side: "r", y: 130 },
  social: { side: "r", y: 330 },
  congress: { side: "r", y: 530 },
};

// SOURCE_LANES also feeds the FinePrint inventory, which lists SUPPORTING sources
// (e.g. Yahoo for charts / Canadian quotes) beyond the 6 core enrichment inputs.
// The animated diagram only has fixed geometry for those 6 - render exactly the
// lanes that have a lane position, so a new inventory source can't crash the scene.
const ENRICH_LANES = SOURCE_LANES.filter((lane) => lane.id in LANE_POS);

function lanePath(id: string): string {
  const pos = LANE_POS[id]!;
  const x0 = pos.side === "l" ? 218 : 982;
  const x1 = pos.side === "l" ? 415 : 785;
  const mid = pos.side === "l" ? 320 : 880;
  return `M ${x0} ${pos.y} C ${mid} ${pos.y}, ${mid} 330, ${x1} 330`;
}

export function SceneEnrichment({
  scroller,
  data,
}: {
  scroller: HTMLElement | null;
  data: StoryData;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const values = laneValues(data);
  const { example } = data;

  const liveDetail =
    data.liveStages.news?.status === "running"
      ? data.liveStages.news.detail
      : data.liveStages.social?.status === "running"
        ? data.liveStages.social.detail
        : data.liveStages.ingest?.status === "running"
          ? data.liveStages.ingest.detail
          : undefined;

  useScrubScene(
    scroller,
    ref,
    (tl, q) => {
      tl.from(q(".enrich-card"), { opacity: 0, scale: 0.94, duration: 0.5 }, 0);

      ENRICH_LANES.forEach((lane, i) => {
        const at = 0.35 + i * 0.42;
        const path = (q(`.enrich-wire--${lane.id}`) as SVGPathElement[])[0];
        const packet = (q(`.enrich-packet--${lane.id}`) as SVGCircleElement[])[0];

        tl.from(q(`.enrich-lane--${lane.id}`), { opacity: 0.18, duration: 0.25 }, at)
          .from(
            q(`.enrich-wire--${lane.id}`),
            { strokeDashoffset: 660, duration: 0.4, ease: "none" },
            at,
          );
        if (path && packet) {
          tl.fromTo(
            packet,
            { opacity: 0 },
            { opacity: 1, duration: 0.05 },
            at + 0.08,
          ).to(
            packet,
            {
              motionPath: { path, align: path, alignOrigin: [0.5, 0.5] },
              duration: 0.34,
              ease: "none",
            },
            at + 0.08,
          ).to(packet, { opacity: 0, duration: 0.05 }, at + 0.4);
        }
        tl.from(
          q(`.enrich-field--${lane.id}`),
          { opacity: 0, y: 8, duration: 0.25 },
          at + 0.34,
        ).fromTo(
          q(".enrich-card__ring"),
          { opacity: 0 },
          { opacity: 1, duration: 0.08, yoyo: true, repeat: 1 },
          at + 0.36,
        );
      });

      tl.from(q(".enrich-na-note"), { opacity: 0, y: 10, duration: 0.35 }, "-=0.2");
    },
    { end: "+=260%" },
    [example.ticker, example.representative],
  );

  return (
    <section ref={ref} className="algo-scene algo-scene--enrich" id="algo-enrichment">
      <div className="algo-scene__stage">
        <header className="algo-scene__head">
          <p className="algo-eyebrow">
            Evidence · “{stageLabel("ingest")}” → “{stageLabel("news")}” → “{stageLabel("social")}”
          </p>
          <h2 className="algo-headline">Six live sources, one company record</h2>
          <p className="algo-dek">
            Each surviving name is hydrated lane by lane — prices, fundamentals,
            headlines, filings, chatter, and Capitol Hill — in the exact order
            the engine runs them.
          </p>
          {liveDetail ? (
            <p className="algo-live-line mono" role="status">▸ {liveDetail}</p>
          ) : null}
        </header>

        <div className="enrich-stage">
          <svg className="enrich-svg" viewBox="0 0 1200 660" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            {ENRICH_LANES.map((lane) => (
              <path
                key={lane.id}
                className={`enrich-wire enrich-wire--${lane.id}`}
                d={lanePath(lane.id)}
                strokeDasharray={660}
              />
            ))}
            {ENRICH_LANES.map((lane) => (
              <circle key={lane.id} className={`enrich-packet enrich-packet--${lane.id}`} r="4.5" />
            ))}
          </svg>

          {ENRICH_LANES.map((lane) => {
            const pos = LANE_POS[lane.id]!;
            return (
              <div
                key={lane.id}
                className={`enrich-lane enrich-lane--${lane.id} enrich-lane--${pos.side} enrich-lane--stage-${lane.stage}`}
                style={{ top: `${(pos.y / 660) * 100}%` }}
              >
                <p className="enrich-lane__source">
                  {lane.source}
                  {lane.keyless ? <span className="enrich-lane__keyless">keyless</span> : null}
                </p>
                <p className="enrich-lane__fills">{lane.fills}</p>
                {lane.note ? <p className="enrich-lane__note">{lane.note}</p> : null}
                <span className={`enrich-lane__stage enrich-lane__stage--${lane.stage}`}>
                  {lane.stage}
                </span>
              </div>
            );
          })}

          <article className="enrich-card" aria-label="Company record being enriched">
            <span className="enrich-card__ring" aria-hidden="true" />
            <header className="enrich-card__head">
              <span className="enrich-card__ticker mono">{example.ticker}</span>
              <span className="enrich-card__name">{example.name}</span>
              <span className="enrich-card__mode">
                {example.representative ? "representative example" : "live · top-ranked signal"}
              </span>
            </header>
            <ul className="enrich-card__fields">
              {ENRICH_LANES.map((lane) => {
                const v = values[lane.id]!;
                return (
                  <li key={lane.id} className={`enrich-field enrich-field--${lane.id}${v.na ? " enrich-field--na" : ""}`}>
                    <span className="enrich-field__label">{v.label}</span>
                    <span className="enrich-field__value mono">{v.value}</span>
                  </li>
                );
              })}
            </ul>
          </article>
        </div>

        <p className="enrich-na-note">
          Missing data is a feature: fields the feeds don’t return read{" "}
          <strong>“N/A” — never fabricated</strong>. Coverage feeds the
          confidence dial, not the score.
        </p>
      </div>
    </section>
  );
}
