import { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useBlueprintStore, annotateResearchedMatches } from "@/store/useBlueprintStore";
import { PageHeader } from "@/components/common/PageHeader";
import { SymbolAutocomplete } from "@/components/common/SymbolAutocomplete";
import { resolveSymbol } from "@/data/symbols/symbolDirectory";
import { ScreenCriteriaForm } from "@/components/screen/ScreenCriteriaForm";
import {
  LiveLeaderboard,
  type ScreenCut,
} from "@/components/screen/LiveLeaderboard";
import { ForgeConsole } from "@/components/screen/ForgeConsole";
import { RankingModeInstructions } from "@/components/screen/RankingModeSelector";
import { DataModeBanner } from "@/components/screen/DataModeBanner";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { Tooltip } from "@/components/common/Tooltip";
import { SYSTEM_NAV } from "@/config/navigationLabels";
import { useState } from "react";
import { useMemo } from "react";
import {
  defaultBlueprintCriteria,
  defaultGrowthScreenCriteria,
  effectiveScreenCriteria,
  evaluateScreenGates,
} from "@/engine/screen";
import {
  type ResearchAgentStatus,
} from "@/data/ai/researchAgent";
import {
  isAiMode,
  isResearchInFlight,
  useResearchLane,
  type BlueprintResearchState,
} from "@/components/screen/researchFlow";
import type {
  ResearchIntel,
  ResearchRun,
  ResearchStage,
  ResearchRunStatus,
  ScreenCriteria,
  ScreenMatch,
  TradeHorizon,
} from "@/types";
import { TRADE_HORIZON_LABELS } from "@/types";
import { IconBeacon, IconCheck, IconForge, IconRefresh, IconSparkle } from "@/components/icons";

const DEFAULT_DESCRIPTION =
  "Promising smaller cap stocks with big growth potential in areas like quantum computing and robotics.";

/** Button copy while the unified run is mid-flight. */
const RUN_PHASE_LABEL: Record<BlueprintResearchState["phase"], string> = {
  idle: "Run Blueprint",
  local: "Scoring locally...",
  web: "AI researching the niche...",
  hydrating: "Fetching fundamentals...",
  ranking: "Merging one board...",
  complete: "Re-run Blueprint",
  paused: "Run Blueprint",
  error: "Run Blueprint",
};

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function describeCriteriaForResearch(criteria: ScreenCriteria, horizons: TradeHorizon[]): string {
  const parts: string[] = [];
  if (horizons.length > 0) {
    parts.push(`horizons ${horizons.map((h) => TRADE_HORIZON_LABELS[h]).join(", ")}`);
  }
  if (criteria.themeTags?.length) parts.push(`theme tags ${criteria.themeTags.join(", ")}`);
  if (criteria.keywords?.length) parts.push(`expanded keywords ${criteria.keywords.slice(0, 12).join(", ")}`);
  if (criteria.sectors?.length) parts.push(`sectors ${criteria.sectors.join(", ")}`);
  if (criteria.capBuckets?.length) parts.push(`market cap ${criteria.capBuckets.join(", ")}`);
  if (criteria.riskLevels?.length) parts.push(`risk levels ${criteria.riskLevels.join(", ")}`);
  if (criteria.catalystTypes?.length) parts.push(`catalysts ${criteria.catalystTypes.join(", ")}`);
  if (criteria.minOpportunityScore) parts.push(`minimum opportunity score ${criteria.minOpportunityScore}`);
  if (criteria.minConfidence) parts.push(`minimum confidence ${criteria.minConfidence}`);
  if (criteria.minRevenueGrowth) parts.push(`minimum revenue growth ${pct(criteria.minRevenueGrowth)}`);
  if (criteria.minEpsGrowth) parts.push(`minimum EPS growth ${pct(criteria.minEpsGrowth)}`);
  if (criteria.minGrossMargin) parts.push(`minimum gross margin ${pct(criteria.minGrossMargin)}`);
  if (criteria.minAvgDollarVolume) parts.push(`minimum average dollar volume ${criteria.minAvgDollarVolume}`);
  if (criteria.maxShortInterestPct) parts.push(`maximum short interest ${pct(criteria.maxShortInterestPct)}`);
  if (criteria.maxPeRatio) parts.push(`maximum P/E ${criteria.maxPeRatio}`);
  if (criteria.requireAboveSMA50) parts.push("must be above 50-day SMA");
  if (criteria.requireAboveSMA200) parts.push("must be above 200-day SMA");
  if (criteria.maxDaysToCatalyst) parts.push(`catalyst within ${criteria.maxDaysToCatalyst} days`);
  if (criteria.preferHype) parts.push("prefer current news, social, and catalyst attention");
  return parts.length ? parts.join("; ") : "no hard filters beyond the narrative";
}

const STARTUP_STAGES = [
  "Ingest market data",
  "Attach fundamentals",
  "Scan headlines",
  "Score universe",
];

function BlueprintStartupState({
  status,
  currentRun,
}: {
  status: ResearchRunStatus;
  currentRun?: ResearchRun;
}) {
  const running = status === "running";
  const error = status === "error";
  const stages: ResearchStage[] = currentRun?.stages.length
    ? currentRun.stages
    : STARTUP_STAGES.map((label, index) => ({
        key: label,
        label,
        status: index === 0 && running ? "running" : "pending",
      }));

  return (
    <div className="forge-studio forge-studio--startup">
      <div className="forge-studio__mesh" aria-hidden />
      <DataModeBanner />
      <section className="signal-card blueprint-startup" aria-live="polite">
        <div className="blueprint-startup__icon" aria-hidden>
          <IconForge size={26} />
        </div>
        <div className="blueprint-startup__copy">
          <p className="section-title">
            {error ? "Blueprint needs a fresh research run" : "Building the Blueprint universe"}
          </p>
          <h2>{error ? "Live data did not finish cleanly" : "Hydrating live stocks before screening"}</h2>
          <p className="text-faint">
            {error
              ? "The screen is ready, but the last market-data run failed before it produced signals."
              : "Blueprint will appear as soon as the app has quotes, fundamentals, headlines, and scored signals. This keeps the screen from presenting thin or fake data."}
          </p>
        </div>

        <div className="blueprint-startup__pipeline" aria-label="Research startup stages">
          {stages.map((stage) => (
            <div key={stage.key} className={`blueprint-startup__stage is-${stage.status}`}>
              <span className="blueprint-startup__stage-mark" aria-hidden>
                {stage.status === "done" ? <IconCheck size={13} /> : null}
              </span>
              <span>
                <strong>{stage.label}</strong>
                {stage.detail && <em>{stage.detail}</em>}
              </span>
            </div>
          ))}
        </div>

        <div className="blueprint-startup__actions">
          <Link to={`${SYSTEM_NAV.core.path}?run=live`} className="btn btn--primary">
            <IconRefresh size={16} />{" "}
            {running ? "Watch the live run in Algorithm" : "Run live & watch in Algorithm"}
          </Link>
          {currentRun?.provider && (
            <span className="text-faint">
              Provider: <span className="mono">{currentRun.provider}</span>
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function RunDock({
  criteria,
  lane,
  research,
  running,
  aiEligible,
  onRun,
}: {
  criteria: ScreenCriteria;
  lane: ResearchAgentStatus;
  research: BlueprintResearchState;
  running: boolean;
  aiEligible: boolean;
  onRun: () => void;
}) {
  const mode = criteria.rankingMode ?? "blended";
  const aiMode = isAiMode(mode);

  return (
    <div className="forge-run" data-lane={aiMode ? "ai" : "local"}>
      <RankingModeInstructions criteria={criteria} />

      {!aiMode ? (
        <div className="forge-run__action">
          <span className="forge-run__live" role="status">
            <i aria-hidden /> Local board — live · re-ranks as you tune
          </span>
          <p className="forge-run__hint text-faint">
            Ranked by business quality — runs instantly on your device. No AI or web search involved.
          </p>
        </div>
      ) : lane.lane === "off" ? (
        <div className="forge-run__action">
          <span className="forge-run__live" role="status">
            <i aria-hidden /> Board is live — AI web search not available on this build
          </span>
          <p className="forge-run__hint text-faint">
            The board ranks stocks using your filters and description. AI web search (which finds
            additional niche names) isn't configured on this build.
          </p>
        </div>
      ) : lane.lane === "paused" ? (
        <div className="forge-run__action">
          <span className="forge-run__live forge-run__live--paused" role="status">
            <i aria-hidden /> Board is live · AI web search paused for today
          </span>
          <p className="forge-run__hint text-faint">
            Today's AI web search budget is spent — the board still ranks live using your filters
            and description. An operator can raise the daily budget in the Operator console.
          </p>
        </div>
      ) : (
        <div className="forge-run__action">
          <Tooltip
            placement="top"
            content={
              aiEligible
                ? "Run the Blueprint now."
                : "Write a longer narrative (13+ characters) so the research agent has a brief to work from."
            }
          >
            <button
              type="button"
              className={`btn btn--primary forge-run__btn${running ? " is-running" : ""}`}
              onClick={onRun}
              aria-disabled={running || !aiEligible}
            >
              <IconForge size={16} />
              <span>{RUN_PHASE_LABEL[research.phase]}</span>
            </button>
          </Tooltip>
          {(running || research.phase === "complete") && (
            <p className="forge-run__hint text-faint" aria-live="polite">
              {running
                ? "Filter results are live on the board while the AI searches the web."
                : `Done — ${research.acceptedCount} AI-found ${research.acceptedCount === 1 ? "stock" : "stocks"} merged into the board. Re-run any time.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Post-run agent notes: grounded summary + sources, kept beside the board. */
function AiResearchNotes({ intel }: { intel: ResearchIntel }) {
  const cites = intel.citations.slice(0, 4);
  if (!intel.summary && cites.length === 0) return null;
  return (
    <aside className="ai-notes" aria-label="AI research notes">
      <div className="ai-notes__head">
        <IconSparkle size={14} />
        <span>AI research notes</span>
        {intel.model ? <span className="ai-notes__model mono">{intel.model}</span> : null}
      </div>
      {intel.summary ? <p className="ai-notes__summary">{intel.summary}</p> : null}
      {cites.length > 0 ? (
        <ul className="ai-notes__cites">
          {cites.map((c) => (
            <li key={c.url}>
              <a href={c.url} target="_blank" rel="noopener noreferrer">
                {c.title}
              </a>
              {c.source ? <span className="text-faint"> · {c.source}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="ai-notes__foot text-faint">
        Research only — verify AI-assisted sources before acting on them.
      </p>
    </aside>
  );
}

export function SignalForge() {
  const nav = SYSTEM_NAV.forge;
  const navigate = useNavigate();
  const signals = useAppStore((s) => s.signals);
  const preferences = useAppStore((s) => s.preferences);
  const screenPresets = useAppStore((s) => s.screenPresets);
  const runScreen = useAppStore((s) => s.runScreen);
  const saveScreenPreset = useAppStore((s) => s.saveScreenPreset);
  const deleteScreenPreset = useAppStore((s) => s.deleteScreenPreset);
  const mergeScreenPresetResults = useAppStore((s) => s.mergeScreenPresetResults);
  const adoptAiRelevanceIntel = useAppStore((s) => s.adoptAiRelevanceIntel);
  const portfolios = useAppStore((s) => s.portfolios);
  const addToPortfolio = useAppStore((s) => s.addToPortfolio);
  const lookupTicker = useAppStore((s) => s.lookupTicker);
  const pushToast = useAppStore((s) => s.pushToast);
  const researchStatus = useAppStore((s) => s.researchStatus);
  const currentRun = useAppStore((s) => s.currentRun);
  const lookupCache = useAppStore((s) => s.lookupCache);

  // ── Blueprint store (survives tab navigation) ───────────────────────────
  const presetName = useBlueprintStore((s) => s.presetName);
  const horizons = useBlueprintStore((s) => s.horizons);
  const criteria = useBlueprintStore((s) => s.criteria);
  const description = useBlueprintStore((s) => s.description);
  const activePresetId = useBlueprintStore((s) => s.activePresetId);
  const matches = useBlueprintStore((s) => s.matches);
  const cuts = useBlueprintStore((s) => s.cuts);
  const researchedTickers = useBlueprintStore((s) => s.researchedTickers);
  const running = useBlueprintStore((s) => s.running);
  const researchState = useBlueprintStore((s) => s.researchState);
  const researchIntel = useBlueprintStore((s) => s.researchIntel);
  const excludeTickers = useBlueprintStore((s) => s.excludeTickers);

  const setPresetName = useBlueprintStore((s) => s.setPresetName);
  const setHorizons = useBlueprintStore((s) => s.setHorizons);
  const setCriteria = useBlueprintStore((s) => s.setCriteria);
  const setDescription = useBlueprintStore((s) => s.setDescription);
  const setActivePresetId = useBlueprintStore((s) => s.setActivePresetId);
  const setMatches = useBlueprintStore((s) => s.setMatches);
  const setCuts = useBlueprintStore((s) => s.setCuts);
  const setResearchedTickers = useBlueprintStore((s) => s.setResearchedTickers);
  const setResearchState = useBlueprintStore((s) => s.setResearchState);
  const setExcludeTickers = useBlueprintStore((s) => s.setExcludeTickers);
  const nextCutId = useBlueprintStore((s) => s.nextCutId);
  const runBlueprint = useBlueprintStore((s) => s.runBlueprint);

  // `jump` is ephemeral text input - not worth persisting across navigations.
  const [jump, setJump] = useState("");

  const lane = useResearchLane();
  const myPortfolios = useMemo(() => portfolios.filter((p) => p.owner === "me"), [portfolios]);

  // Initialise horizons from preferences on FIRST mount only (store default
  // is "position_trading"; override with the persisted user preference once).
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    const pref = preferences.tradeHorizon;
    if (pref && pref !== horizons[0]) {
      setHorizons([pref]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ref mirrors to avoid stale closure in the screen effect.
  const prevMatchesRef = useRef<ScreenMatch[]>([]);

  // The live instrument: every input change re-screens the universe (pure and
  // synchronous, same 180ms debounce as the HUD preview), diffing the previous
  // board so the exact gate that cut each departing name can be reported.
  useEffect(() => {
    if (signals.length === 0) return;
    const handle = setTimeout(() => {
      const next = annotateResearchedMatches(
        runScreen(horizons, criteria, description, excludeTickers),
        researchedTickers,
      );
      const nextTickers = new Set(next.map((m) => m.signal.ticker));
      const removed = prevMatchesRef.current.filter(
        (m) => !nextTickers.has(m.signal.ticker),
      );
      if (removed.length > 0) {
        const eff = effectiveScreenCriteria(horizons, criteria);
        const excluded = new Set(excludeTickers.map((t) => t.toUpperCase()));
        const newCuts: ScreenCut[] = removed.slice(0, 4).map((m) => {
          const id = nextCutId();
          const ticker = m.signal.ticker;
          if (excluded.has(ticker.toUpperCase())) {
            return {
              id,
              ticker,
              gateLabel: "Saved to screen",
              actual: "banked",
              required: "new names only",
            };
          }
          const failed = evaluateScreenGates(m.signal, eff).find((g) => !g.pass && !g.unknown);
          return failed
            ? {
                id,
                ticker,
                gateLabel: failed.label,
                actual: failed.actual,
                required: failed.required,
              }
            : {
                id,
                ticker,
                gateLabel: "Ranking cut",
                actual: `fit ${m.fitScore}`,
                required: criteria.maxResults ? `top ${criteria.maxResults}` : "on board",
              };
        });
        setCuts((prev) => [...newCuts, ...prev].slice(0, 5));
      }
      prevMatchesRef.current = next;
      setMatches(next);
    }, 180);
    return () => clearTimeout(handle);
  }, [
    signals,
    horizons,
    criteria,
    description,
    excludeTickers,
    researchedTickers,
    lookupCache,
    runScreen,
    nextCutId,
    setCuts,
    setMatches,
  ]);

  if (signals.length === 0) {
    return (
      <>
        <PageHeader title={nav.label} description={nav.tagline} />
        <BlueprintStartupState status={researchStatus} currentRun={currentRun} />
        <InvestingDisclaimer className="page-disclaimer" />
      </>
    );
  }

  const loadPreset = (id: string) => {
    const p = screenPresets.find((x) => x.id === id);
    if (!p) return;
    setActivePresetId(p.id);
    setPresetName(p.name);
    setHorizons(p.horizons?.length ? p.horizons : [p.horizon]);
    setCriteria(p.criteria);
    setDescription(p.description);
    setExcludeTickers(p.savedTickers);
  };

  const mode = criteria.rankingMode ?? "blended";
  const aiMode = isAiMode(mode);
  const aiEligible = description.trim().length > 12;
  const busy = isResearchInFlight(researchState.phase);

  const handleRunBlueprint = () => {
    void runBlueprint({
      runScreen,
      adoptAiRelevanceIntel,
      lookupTicker,
      mergeScreenPresetResults,
    });
  };

  const handleSave = () => {
    const primary = horizons[0] ?? "position_trading";
    const saved = saveScreenPreset({
      id: activePresetId ?? undefined,
      name: presetName,
      horizon: primary,
      horizons,
      criteria,
      description,
      savedTickers: activePresetId
        ? screenPresets.find((p) => p.id === activePresetId)?.savedTickers ?? []
        : [],
      lastRunAt: matches.length > 0 ? new Date().toISOString() : undefined,
    });
    setActivePresetId(saved.id);
    pushToast(`Saved "${saved.name}" — find it under Saved screens below`, "success");
  };

  const handleDeletePreset = (id: string) => {
    deleteScreenPreset(id);
    if (activePresetId === id) {
      setActivePresetId(null);
      setExcludeTickers([]);
    }
  };

  return (
    <div className="forge-page">
      <div className="forge-page__wash" aria-hidden />
      <div className="forge-page__content">
        <PageHeader title={nav.label} description={nav.tagline} />
        <DataModeBanner />

        <div className="forge-cockpit">
          {/* ── Inputs: name → narrative → mode + Run → filters ─────────────── */}
        <section className="forge-cockpit__inputs" aria-label="Blueprint controls">
          <header className="forge-cockpit__bar">
            <div className="field forge-panel__name">
              <label htmlFor="screen-name">Screen name</label>
              <input
                id="screen-name"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="e.g. Small cap growth themes"
              />
            </div>
            <div className="forge-jump">
              <label htmlFor="forge-jump-input">Jump to ticker</label>
              <SymbolAutocomplete
                id="forge-jump-input"
                value={jump}
                onChange={setJump}
                onPick={(rec) => {
                  setJump("");
                  navigate(`/signal/${encodeURIComponent(rec.symbol)}`);
                }}
                onSubmitText={(v) => {
                  const rec = resolveSymbol(v);
                  if (rec) {
                    setJump("");
                    navigate(`/signal/${encodeURIComponent(rec.symbol)}`);
                  }
                }}
                placeholder="Any US / CA listing…"
                ariaLabel="Jump to a ticker's full detail"
                variant="pill"
                size="sm"
                leading={<IconBeacon size={15} />}
              />
            </div>
            <div className="forge-cockpit__bar-actions">
              <Tooltip
                placement="bottom"
                content="Keeps this whole setup — narrative, tags, filters, horizons — under Saved screens below."
              >
                <button type="button" className="btn btn--ghost btn--sm" onClick={handleSave}>
                  Save screen
                </button>
              </Tooltip>
              <Tooltip
                placement="bottom"
                content="Loads a 'next NVIDIA' starting point: small caps, growth floors, momentum — then tune from there."
              >
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setCriteria(defaultGrowthScreenCriteria());
                    setHorizons(["position_trading", "swing_trading"]);
                    setDescription(DEFAULT_DESCRIPTION);
                  }}
                >
                  <IconRefresh size={14} /> Growth preset
                </button>
              </Tooltip>
            </div>
          </header>

          <div className="signal-card forge-panel forge-panel--studio">
            <div className="forge-panel__sheen" aria-hidden />
            <ScreenCriteriaForm
              variant="forge"
              horizons={horizons}
              onHorizonsChange={setHorizons}
              criteria={criteria}
              onCriteriaChange={setCriteria}
              description={description}
              onDescriptionChange={setDescription}
              runSlot={
                <RunDock
                  criteria={criteria}
                  lane={lane}
                  research={researchState}
                  running={running}
                  aiEligible={aiEligible}
                  onRun={handleRunBlueprint}
                />
              }
            />
          </div>
        </section>

        {/* ── Outputs: pinned console + the board, visible while tuning ───── */}
        <section
          className={`forge-cockpit__outputs forge-results${busy ? " forge-results--busy" : ""}`}
          aria-label="Blueprint results"
          aria-busy={busy}
        >
          <div className="forge-console-pin">
            <ForgeConsole
              matches={matches}
              cuts={cuts}
              horizons={horizons}
              criteria={criteria}
              research={researchState}
              lane={lane.lane}
              aiMode={aiMode}
            />
            <div className="forge-results__head">
              <div className="section-title">
                Ranked board
                <span className={`lb-live-tag${busy ? " lb-live-tag--busy" : ""}`}>
                  {busy ? "preliminary — AI researching…" : "live — re-ranks as you tune"}
                </span>
              </div>
              {activePresetId && matches.length > 0 && (
                <Tooltip
                  placement="bottom"
                  content="Stash the current matches on this saved screen — they'll be excluded so re-runs hunt for new names."
                >
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      const banked = matches.map((m) => m.signal.ticker);
                      mergeScreenPresetResults(activePresetId, banked);
                      setExcludeTickers((prev) => [...new Set([...prev, ...banked])]);
                      pushToast(
                        `Banked ${banked.length} ${banked.length === 1 ? "name" : "names"} — the screen will hunt for new ones`,
                        "success",
                      );
                    }}
                  >
                    Bank results
                  </button>
                </Tooltip>
              )}
              {activePresetId && (
                <span className="text-faint forge-results__note">
                  Saved names excluded — runs stack new ones
                </span>
              )}
            </div>
          </div>

          {researchIntel ? <AiResearchNotes intel={researchIntel} /> : null}

          {matches.length === 0 ? (
            <div className="empty forge-empty">
              <h3>No matches</h3>
              <p>
                Loosen filters, add theme tags, or broaden your narrative — the
                board re-ranks the moment you do.
              </p>
              {criteria.minOpportunityScore != null && criteria.minOpportunityScore > 0 ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm forge-empty__action"
                  onClick={() => {
                    setCriteria({
                      ...criteria,
                      minOpportunityScore: Math.max(0, (criteria.minOpportunityScore ?? 0) - 10),
                    });
                  }}
                >
                  Relax opportunity floor
                </button>
              ) : null}
            </div>
          ) : (
            <LiveLeaderboard
              matches={matches}
              researchedTickers={researchedTickers}
              portfolios={myPortfolios}
              onAddToPortfolio={addToPortfolio}
            />
          )}
        </section>
      </div>

      {/* ── Saved screens vault - reference material, out of the cockpit ──── */}
      <section className="forge-vault" aria-label="Saved screens">
        <div className="forge-vault__head">
          <span className="section-title">Saved screens</span>
          <span className="text-faint forge-vault__hint">
            Load one to restore its setup — banked names stay excluded so re-runs hunt fresh.
          </span>
          <Link to={SYSTEM_NAV.core.path} className="text-faint forge-vault__link">
            How this works → {SYSTEM_NAV.core.label}
          </Link>
        </div>
        {screenPresets.length === 0 ? (
          <p className="forge-vault__empty text-faint">
            Nothing saved yet — name the screen above and press Save to keep this setup and stack
            tickers across runs.
          </p>
        ) : (
          <div className="forge-vault__grid">
            {screenPresets.map((p) => (
              <div
                key={p.id}
                className={`forge-vault__card${activePresetId === p.id ? " is-active" : ""}`}
              >
                <button type="button" className="forge-vault__load" onClick={() => loadPreset(p.id)}>
                  <span className="forge-vault__name">{p.name}</span>
                  <span className="forge-vault__meta mono">
                    {p.savedTickers.length} banked
                  </span>
                </button>
                <button
                  type="button"
                  className="forge-vault__delete"
                  aria-label={`Delete saved screen ${p.name}`}
                  onClick={() => handleDeletePreset(p.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

        <InvestingDisclaimer className="page-disclaimer" />
      </div>
    </div>
  );
}
