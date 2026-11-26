import { FOR_YOU_FILTERS } from "@/feed/feedFilters";
import { EMERGING_THEMES } from "@/feed/emergingThemes";
import type { ForYouFilterId } from "@/types";

interface ForYouFilterBarProps {
  active: ForYouFilterId[];
  /** Active emerging-theme slugs; undefined = all themes in scope. */
  themeScope?: string[];
  /** Per-filter match counts across the current board (chip badges). */
  counts: Partial<Record<ForYouFilterId, number>>;
  onToggleFilter: (id: ForYouFilterId) => void;
  onToggleTheme: (slug: string) => void;
  onAllThemes: () => void;
}

/**
 * The For-You personalization control row: hard-filter chips ("show me more
 * of…") plus, while Emerging themes is active, the theme-scope sub-row. Pure
 * presentational - matching lives in src/feed/feedFilters.ts.
 */
export function ForYouFilterBar({
  active,
  themeScope,
  counts,
  onToggleFilter,
  onToggleTheme,
  onAllThemes,
}: ForYouFilterBarProps) {
  const themesOn = active.includes("emerging_themes");
  const scopeIsAll = themeScope == null || themeScope.length >= EMERGING_THEMES.length;
  const scope = themeScope ?? EMERGING_THEMES.map((t) => t.slug);

  return (
    <div className="fy-filters" role="group" aria-label="Feed filters">
      <span className="act-group-label">Show me more of</span>
      <div className="fy-filters__row">
        {FOR_YOU_FILTERS.map((f) => {
          const isActive = active.includes(f.id);
          const count = counts[f.id];
          return (
            <button
              key={f.id}
              type="button"
              className={`fy-chip${isActive ? " fy-chip--active" : ""}`}
              aria-pressed={isActive}
              title={f.hint}
              onClick={() => onToggleFilter(f.id)}
            >
              {f.label}
              {isActive && count != null && (
                <em className="fy-chip__count mono">{count}</em>
              )}
            </button>
          );
        })}
      </div>
      {themesOn && (
        <div className="fy-themes" role="group" aria-label="Emerging themes in scope">
          <button
            type="button"
            className={`fy-theme-chip${scopeIsAll ? " fy-theme-chip--active" : ""}`}
            aria-pressed={scopeIsAll}
            title="Every curated theme counts. Tap a single theme to zero in on it."
            onClick={onAllThemes}
          >
            All themes
          </button>
          {EMERGING_THEMES.map((t) => {
            const on = !scopeIsAll && scope.includes(t.slug);
            return (
              <button
                key={t.slug}
                type="button"
                className={`fy-theme-chip${on ? " fy-theme-chip--active" : ""}`}
                aria-pressed={on}
                title={t.tagline}
                onClick={() => onToggleTheme(t.slug)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
