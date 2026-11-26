import { useMemo, useState, type ReactNode } from "react";
import type { ScreenCriteria } from "@/types";
import { SCREEN_THEME_TAGS } from "@/constants/screenThemes";
import { previewNarrativeChips } from "@/engine/screen";
import { InfoTip, Tooltip } from "@/components/common/Tooltip";
import { runResearchAgent, ResearchProxyError } from "@/data/ai/researchAgent";
import { useResearchLane } from "@/components/screen/researchFlow";
import { RankingModePills } from "@/components/screen/RankingModeSelector";

interface NarrativeIntelPanelProps {
  description: string;
  onDescriptionChange: (d: string) => void;
  criteria: ScreenCriteria;
  onCriteriaChange: (c: ScreenCriteria) => void;
  /** The mode + Run dock - rendered right after the theme tags so the page's
   *  one primary action sits above the fold, before the fine-tuning controls. */
  runSlot?: ReactNode;
}

const NARRATIVE_PRESETS = [
  { weight: 35, label: "Filters-first", hint: "Horizon and fundamentals lead ranking" },
  { weight: 65, label: "Balanced", hint: "Default Blueprint blend" },
  { weight: 85, label: "Theme-first", hint: "Strong narrative/theme matches rise" },
] as const;

function toggleTag(list: string[] | undefined, id: string): string[] {
  const base = list ?? [];
  return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
}

function narrativeRankingOn(criteria: ScreenCriteria): boolean {
  return (criteria.narrativeWeight ?? 65) > 0;
}

function activePresetWeight(criteria: ScreenCriteria): number {
  const w = criteria.narrativeWeight ?? 65;
  if (w <= 0) return 65;
  const match = NARRATIVE_PRESETS.find((p) => p.weight === w);
  return match?.weight ?? 65;
}

export function NarrativeIntelPanel({
  description,
  onDescriptionChange,
  criteria,
  onCriteriaChange,
  runSlot,
}: NarrativeIntelPanelProps) {
  const chips = useMemo(
    () => previewNarrativeChips(description, criteria.themeTags),
    [description, criteria.themeTags],
  );
  // AI-expanded keywords live on criteria.keywords (merged by "Expand theme
  // terms" / preset loads) - surface them so the user can SEE what widened
  // the screen, distinct from their own typed tokens.
  const expandedChips = useMemo(() => {
    const own = new Set(chips);
    return (criteria.keywords ?? []).filter((k) => !own.has(k)).slice(0, 12);
  }, [chips, criteria.keywords]);

  const rankingOn = narrativeRankingOn(criteria);
  const presetWeight = activePresetWeight(criteria);
  const activePreset =
    NARRATIVE_PRESETS.find((p) => p.weight === presetWeight) ?? NARRATIVE_PRESETS[1]!;

  // ── Expand theme terms - the agent widens the keyword family. ───────────────
  const lane = useResearchLane();
  const [expandStatus, setExpandStatus] = useState<"idle" | "running" | "error">("idle");
  const [expandNote, setExpandNote] = useState<string | null>(null);
  const narrativeReady = description.trim().length >= 12;
  const expandEnabled = lane.lane === "ready" && narrativeReady && expandStatus !== "running";

  const expandTip =
    lane.lane === "off"
      ? "AI expansion isn't available on this build. Local keyword expansion from your text and tags still runs."
      : lane.lane === "paused"
        ? "AI research is paused for today — the daily budget is spent. An operator can raise it in the Operator console."
        : !narrativeReady
          ? "Write a bit more in the narrative so the AI has enough to work from."
          : "Asks the AI to find related niche terms — suppliers, adjacent tech, industry jargon — and adds them to your keywords, widening both the local match and the AI web search.";

  const runExpand = async () => {
    if (!expandEnabled) return;
    setExpandStatus("running");
    setExpandNote(null);
    try {
      const result = await runResearchAgent({
        narrative: description,
        themes: criteria.themeTags,
        task: "theme_expand",
      });
      const themes = (result.themes ?? []).map((t) => t.toLowerCase()).filter(Boolean);
      setExpandStatus("idle");
      if (themes.length > 0) {
        const merged = [...new Set([...(criteria.keywords ?? []), ...themes])];
        onCriteriaChange({ ...criteria, keywords: merged });
        setExpandNote(`Added ${themes.length} related ${themes.length === 1 ? "term" : "terms"}.`);
      } else {
        setExpandNote("The agent found no new related terms for this narrative.");
      }
    } catch (err) {
      setExpandStatus("error");
      setExpandNote(
        err instanceof ResearchProxyError
          ? err.message
          : "Theme expansion did not come back — your keywords are unchanged.",
      );
    }
  };

  return (
    <section className="forge-narrative" aria-labelledby="forge-narrative-title">
      <div className="forge-narrative__head">
        <div>
          <h2 id="forge-narrative-title" className="forge-narrative__title">
            Research narrative
          </h2>
        </div>
      </div>

      <textarea
        className="forge-narrative__input"
        rows={4}
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        placeholder="Describe the opportunity — themes, catalysts, sectors, exclusions, or a 'next NVIDIA' angle. e.g. Promising small caps in quantum computing and warehouse robotics with near-term catalysts and rising social attention."
        aria-labelledby="forge-narrative-title"
      />

      {/* The Run Blueprint action + its live mode instructions live in the MAIN
          flow, never buried in the advanced dropdown - the local board ranks
          live as you type/filter, and this button fires the AI niche search for
          the AI ranking modes. The mode itself is PICKED inside the dropdown
          below; this slot reacts to that choice live. */}
      {runSlot ? <div className="forge-run-slot">{runSlot}</div> : null}

      {/* Advanced research & AI settings - collapsed by default so the main flow
          stays "narrative → run → live board". Uses the SAME forge-filter-section
          shell as the Sectors/Cap/Catalyst/Technicals dropdowns, plus an accent
          `--advanced` tint so it reads as the research/AI control surface rather
          than a fundamental filter. Holds: ranking mode · hype mode · theme tags ·
          narrative weight · the extracted-signal preview. */}
      <details className="forge-filter-section forge-advanced-section">
        <summary className="forge-filter-section__summary">
          <span className="forge-filter-section__title">
            Advanced research &amp; AI settings
            <InfoTip
              label="What advanced research & AI settings do"
              content={
                <>
                  These control <strong>how stocks are sorted and what the AI looks for</strong> —
                  not which names are filtered out. Pick a sort mode, turn on hype, choose theme
                  tags, and set how much your written description influences the order.
                </>
              }
            />
          </span>
          <span className="forge-filter-section__hint text-faint">
            How stocks are ranked · hype · theme tags · narrative weight
          </span>
        </summary>
        <div className="forge-filter-section__body col gap-4">

          {/* ── Ranking mode - moved in here per the rework. Picking a pill
              updates `criteria.rankingMode`, which the Run dock's instructions
              and button (outside this dropdown) react to live. Defaults to
              Blended. ── */}
          <div className="forge-adv-group">
            <span className="forge-narrative__chip-label">
              Ranking mode
              <InfoTip
                label="What ranking mode does"
                content={
                  <>
                    Controls <strong>what the board sorts by</strong> — pure business quality, a
                    blend of quality + theme + description, or the AI's relevance score. The Run
                    button and its description below update the moment you switch.
                  </>
                }
              />
            </span>
            <RankingModePills criteria={criteria} onCriteriaChange={onCriteriaChange} />
          </div>

          {/* ── Hype mode - a proper two-state segmented control (was a bare
              checkbox that floated like a stray gray square). ── */}
          <div className="forge-adv-group">
            <span className="forge-narrative__chip-label">
              Hype mode
              <InfoTip
                label="What hype mode does"
                content="Tilts ranking toward names with live news, social attention, and near-term catalysts. Off keeps the board on quality and fit alone."
              />
            </span>
            <div
              className="forge-seg"
              role="radiogroup"
              aria-label="Hype mode"
            >
              <button
                type="button"
                role="radio"
                aria-checked={criteria.preferHype !== true}
                className={`forge-seg__btn${criteria.preferHype !== true ? " forge-seg__btn--on" : ""}`}
                onClick={() => onCriteriaChange({ ...criteria, preferHype: undefined })}
              >
                Off
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={criteria.preferHype === true}
                className={`forge-seg__btn forge-seg__btn--accent${criteria.preferHype === true ? " forge-seg__btn--on" : ""}`}
                onClick={() => onCriteriaChange({ ...criteria, preferHype: true })}
              >
                On — news + social + catalyst
              </button>
            </div>
          </div>

      <div className="field forge-themes forge-adv-group">
        <span className="forge-narrative__chip-label">
          Theme tags
          <InfoTip
            label="What theme tags do"
            content={
              <>
                Each tag expands into a keyword family matched against every stock's thesis,
                news, and social text — and briefs the AI niche search.{" "}
                <strong>None selected = no theme constraint:</strong> the whole universe still
                ranks.
              </>
            }
          />
        </span>
        <div className="chip-grid" role="group" aria-label="Theme tags">
          {SCREEN_THEME_TAGS.map((tag) => {
            const selected = criteria.themeTags?.includes(tag.id) ?? false;

            return (
              <span
                key={tag.id}
                className={`forge-theme-chip${selected ? " forge-theme-chip--selected" : ""}`}
              >
                <Tooltip
                  placement="top"
                  className="forge-theme-chip__label-tip"
                  content={
                    <>
                      <strong className="tip__range">{tag.label}</strong>
                      <span className="tip__hint">
                        Matches: {tag.keywords.slice(0, 5).join(", ")}. Boosts theme fit locally
                        and steers the AI search toward this niche.
                      </span>
                    </>
                  }
                >
                  <button
                    type="button"
                    className={`forge-chip ${selected ? "forge-chip--on" : ""}`}
                    aria-pressed={selected}
                    onClick={() =>
                      onCriteriaChange({
                        ...criteria,
                        themeTags: toggleTag(criteria.themeTags, tag.id),
                      })
                    }
                  >
                    {tag.label}
                  </button>
                </Tooltip>
                {selected ? (
                  <Tooltip
                    content={expandStatus === "running" ? "Expanding..." : expandTip}
                    placement="top"
                    className="forge-theme-chip__expand-tip"
                  >
                    <button
                      type="button"
                      className="forge-theme-chip__expand"
                      onClick={() => void runExpand()}
                      aria-label={
                        expandStatus === "running"
                          ? `Expanding ${tag.label} theme terms`
                          : `Expand ${tag.label} theme terms`
                      }
                      aria-disabled={!expandEnabled}
                      aria-busy={expandStatus === "running"}
                    >
                      <span aria-hidden="true">+</span>
                    </button>
                  </Tooltip>
                ) : null}
              </span>
            );
          })}
        </div>

        {lane.lane !== "ready" || expandNote ? (
          <div className="forge-expand">
            {lane.lane !== "ready" ? (
              <span className="forge-expand__why text-faint">
                {lane.lane === "off"
                  ? "AI expansion not available on this build — local expansion still applies."
                  : "AI paused for today — daily budget spent."}
              </span>
            ) : null}
            {expandNote ? (
              <span
                className={`forge-expand__note${expandStatus === "error" ? " forge-expand__note--warn" : ""}`}
                role="status"
              >
                {expandNote}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={`forge-influence ${rankingOn ? "is-active" : ""}`}>
        <div className="forge-influence__head">
          <label className="forge-toggle forge-toggle--compact">
            <input
              type="checkbox"
              checked={rankingOn}
              onChange={(e) =>
                onCriteriaChange({
                  ...criteria,
                  narrativeWeight: e.target.checked
                    ? presetWeight > 0
                      ? presetWeight
                      : 65
                    : 0,
                })
              }
            />
            <span className="forge-influence__title">Weight narrative in ranking</span>
          </label>
          <InfoTip
            label="What narrative weight does"
            content={
              <>
                When on, stocks that better match your description and theme tags rank higher.
                When off, your narrative still feeds the AI search and keyword matching — it just
                doesn't affect the sort order.
              </>
            }
          />
          <span
            className={`forge-influence__value ${rankingOn ? "" : "forge-influence__value--auto"}`}
          >
            {rankingOn ? activePreset.label : "Off — filters only"}
          </span>
        </div>

        {rankingOn && (
          <div className="forge-influence__body">
            <div className="chip-grid" role="group" aria-label="Narrative ranking emphasis">
              {NARRATIVE_PRESETS.map((preset) => (
                <button
                  key={preset.weight}
                  type="button"
                  className={`forge-chip ${presetWeight === preset.weight ? "forge-chip--on" : ""}`}
                  title={preset.hint}
                  onClick={() =>
                    onCriteriaChange({ ...criteria, narrativeWeight: preset.weight })
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="forge-influence__note">{activePreset.hint}</p>
          </div>
        )}
      </div>

      {/* ── Extracted signals - moved off the top of the page (it was clutter
          the user couldn't act on) into this advanced panel, where it reads as
          a live diagnostic: the exact keyword tokens the engine matches. ── */}
      {chips.length > 0 || expandedChips.length > 0 ? (
        <div className="forge-narrative__extracted forge-adv-group" aria-live="polite">
          <span className="forge-narrative__chip-label">
            Extracted signals
            <InfoTip
              label="What extracted signals are"
              content="The keyword tokens the engine actually matches against each stock — parsed live from your narrative, theme tags, and any AI-expanded terms. Read-only: edit your narrative or tags to change them."
            />
          </span>
          <div className="forge-narrative__tokens">
            {chips.map((k) => (
              <span key={k} className="forge-token">
                {k}
              </span>
            ))}
            {expandedChips.map((k) => (
              <span
                key={`x_${k}`}
                className="forge-token forge-token--expanded"
                title="Added by Expand theme terms"
              >
                {k}
              </span>
            ))}
          </div>
        </div>
      ) : null}
        </div>
      </details>
    </section>
  );
}
