import { useMemo } from "react";
import { useAppStore } from "@/store/useAppStore";
import { isSampleDataModeEnabled } from "@/data/providers";
import { relativeTime } from "@/lib/format";

/**
 * Usage tracking surface. Summarizes how often the research engine has actually
 * worked for this user - total runs, recent cadence, and ticker lookups - all
 * from persisted state (`researchRunLog`, `lookupCount`, `lastRun`). The 7-day
 * strip is a real per-day count, not decoration.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

interface Props {
  /** `full` = stat grid + 7-day strip (Research page); `compact` = one row (tiles). */
  variant?: "full" | "compact";
}

export function UsagePanel({ variant = "full" }: Props) {
  const runLog = useAppStore((s) => s.researchRunLog);
  const runTotal = useAppStore((s) => s.researchRunTotal);
  const lookupCount = useAppStore((s) => s.lookupCount);
  const lastRun = useAppStore((s) => s.lastRun);
  const sampleDataMode = isSampleDataModeEnabled();

  const stats = useMemo(() => {
    const now = Date.now();
    const times = runLog.map((iso) => Date.parse(iso)).filter((t) => Number.isFinite(t));
    const last24h = times.filter((t) => now - t < DAY_MS).length;
    const last7d = times.filter((t) => now - t < 7 * DAY_MS).length;

    // Runs per day for the last 7 calendar days (oldest → today).
    const days: { label: string; count: number }[] = [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const dayStart = startOfToday.getTime() - i * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      const count = times.filter((t) => t >= dayStart && t < dayEnd).length;
      days.push({ label: DAY_LABELS[new Date(dayStart).getDay()], count });
    }
    const peak = Math.max(1, ...days.map((d) => d.count));
    return { total: Math.max(runTotal, times.length), last24h, last7d, days, peak };
  }, [runLog, runTotal]);

  if (variant === "compact") {
    return (
      <div className="usage-compact">
        <UsageTile value={stats.total} label="Total runs" />
        <UsageTile value={stats.last7d} label="Past 7 days" accent />
        <UsageTile value={lookupCount} label="Lookups" />
      </div>
    );
  }

  return (
    <div className="usage-panel">
      <div className="usage-panel__grid">
        <UsageTile value={stats.total} label="Total research runs" />
        <UsageTile value={stats.last24h} label="Past 24h" />
        <UsageTile value={stats.last7d} label="Past 7 days" accent />
        <UsageTile value={lookupCount} label="Ticker lookups" />
      </div>

      <div className="usage-panel__strip" aria-hidden="true">
        {stats.days.map((d, i) => (
          <div className="usage-bar" key={i} title={`${d.count} run${d.count === 1 ? "" : "s"}`}>
            <div className="usage-bar__track">
              <span
                className={`usage-bar__fill ${d.count > 0 ? "is-active" : ""}`}
                style={{ height: `${Math.round((d.count / stats.peak) * 100)}%` }}
              />
            </div>
            <span className="usage-bar__label">{d.label}</span>
          </div>
        ))}
      </div>

      <div className="usage-panel__foot text-faint">
        {lastRun?.finishedAt
          ? `Last run ${relativeTime(lastRun.finishedAt)} · ${lastRun.provider} · totals persist across reloads and mode toggles${sampleDataMode ? " · Sample mode regeneration counts as a run" : ""}`
          : "No runs yet · totals persist on this device until app storage is cleared."}
      </div>
    </div>
  );
}

function UsageTile({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className={`usage-tile ${accent ? "usage-tile--accent" : ""}`}>
      <div className="usage-tile__value mono">{value}</div>
      <div className="usage-tile__label">{label}</div>
    </div>
  );
}
