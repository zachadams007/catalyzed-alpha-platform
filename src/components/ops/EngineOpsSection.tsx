import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { getActiveProvider, isResearchRunAllowed, listProviders } from "@/data/providers";
import { ApiQuotaBoard, useApiUsage } from "@/components/ops/ApiQuotaBoard";
import { ManualRefreshCard, useRefreshLimit } from "@/components/ops/RefreshLimit";
import { IconRefresh } from "@/components/icons";
import { relativeTime } from "@/lib/format";
import { isFinnhubConfigured } from "@/data/http";
import { verifyFinnhub, type FinnhubVerifyResult } from "@/data/finnhub/verify";
import { RESEARCH_RUN_HOUR as SCHEDULE_HOUR } from "@/lib/researchSchedule";
import {
  isMarketProxyConfigured,
  planFallback,
  type FallbackProviderId,
} from "@/data/marketProxy";

/** Human labels for the on-429 Finnhub fallback chain. */
const FALLBACK_LABEL: Record<FallbackProviderId, string> = {
  finnhub: "Finnhub (primary)",
  finnhub2: "2nd Finnhub key",
  polygon: "Polygon.io",
  tiingo: "Tiingo",
};

/**
 * Research automation ops - the operational stats that used to live on the
 * Research tab (now the analyst Research Desk). Surfaces market-scan run counts,
 * per-source API quota, key/provider health, and cadence on Your Desk. Operator
 * depth (overrides, kill-switches) stays on /admin.
 */
export function EngineOpsSection() {
  const status = useAppStore((s) => s.researchStatus);
  const lastRun = useAppStore((s) => s.lastRun);
  const fromShared = useAppStore((s) => s.signalsFromShared);
  const runHistory = useAppStore((s) => s.runHistory);
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  const [finnhubCheck, setFinnhubCheck] = useState<FinnhubVerifyResult | null>(null);

  useEffect(() => {
    if (!isFinnhubConfigured()) {
      setFinnhubCheck({ status: "missing_key" });
      return;
    }
    let cancelled = false;
    void verifyFinnhub().then((r) => {
      if (!cancelled) setFinnhubCheck(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const running = status === "running";
  useApiUsage();
  const researchAllowed = isResearchRunAllowed();
  const refreshLimit = useRefreshLimit();
  const limited = refreshLimit.blocked;
  const activeProvider = getActiveProvider();
  const providers = listProviders();
  const proxied = isMarketProxyConfigured();
  // On the hosted keyless build, vendor keys (incl. backups) live server-side on
  // the proxy - the client can't see them, so don't claim to. Only inspect the
  // local fallback chain when there's no proxy (operator/desktop builds).
  const backups = proxied ? [] : planFallback();
  const boardCount = lastRun?.signalsGenerated ?? 0;

  return (
    <section className="engine-ops">
      <div className="engine-ops__head">
        <div>
          <div className="ops-card__title" style={{ marginBottom: 2 }}>
            Research automation
          </div>
          <p className="ops-card__sub" style={{ margin: 0 }}>
            How the market-wide scan that powers Today, Weekly &amp; For You is running — its counts,
            API quota, and data keys. Per-stock analyst diligence lives on the{" "}
            <Link to="/research">Research Desk</Link>.
          </p>
        </div>
        <button
          className="btn btn--primary btn--sm"
          onClick={() => runResearchNow("manual")}
          disabled={running || !researchAllowed || limited}
          title={
            !researchAllowed
              ? "Live/API data access is off in the Operator Console"
              : limited
                ? `Daily manual-refresh limit reached (${refreshLimit.limit}/${refreshLimit.limit}). Resets at midnight.`
                : refreshLimit.unlimited
                  ? undefined
                  : `${refreshLimit.remaining} of ${refreshLimit.limit} manual scans left today`
          }
        >
          {running ? <span className="spinner" /> : <IconRefresh size={15} />}
          {running
            ? "Scanning…"
            : !researchAllowed
              ? "API access off"
              : limited
                ? "Limit reached"
                : "Scan Market"}
        </button>
      </div>

      {/* Run counts */}
      <div className="desk-stat-row engine-ops__stats">
        <div className="usage-tile">
          <div className="usage-tile__value" style={{ fontSize: 16 }}>
            {running ? "Scanning" : status === "complete" ? "Idle · Ready" : status === "error" ? "Error" : "Idle"}
          </div>
          <div className="usage-tile__label">Status</div>
        </div>
        <div className="usage-tile">
          <div className="usage-tile__value" style={{ fontSize: 16 }}>
            {lastRun?.finishedAt ? relativeTime(lastRun.finishedAt) : "—"}
          </div>
          <div className="usage-tile__label">Last scan</div>
        </div>
        <div className="usage-tile">
          <div className="usage-tile__value mono">{lastRun?.signalsGenerated ?? 0}</div>
          <div className="usage-tile__label">Signals</div>
        </div>
        <div className="usage-tile">
          <div className="usage-tile__value mono" style={{ fontSize: 16 }}>
            {lastRun?.durationMs ? `${(lastRun.durationMs / 1000).toFixed(1)}s` : "—"}
          </div>
          <div className="usage-tile__label">Duration</div>
        </div>
      </div>

      {/* Per-source API quota / data quality */}
      <ApiQuotaBoard />

      <div className="engine-ops__grid">
        <div className="col gap-4">
          <ManualRefreshCard />

          {/* Daily market scan - the shared cloud broad scan + this device's source */}
          <div className="ops-card">
            <div className="ops-card__title">Daily market scan</div>
            <p className="ops-card__sub" style={{ marginTop: 0 }}>
              A scheduled cloud scan sweeps the whole US market pre-market, scores the top names, and
              publishes one shared board every device reads.
            </p>
            <div className="row-between">
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {fromShared ? "Reading the shared board" : "Computed on this device"}
                </div>
                <div className="text-faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {fromShared
                    ? "This device reads the shared board — zero vendor calls."
                    : "Local scan — the shared board hadn’t published yet."}
                </div>
              </div>
              <span className={`pill ${fromShared ? "pill--risk-Low" : ""}`}>
                {fromShared ? "Shared" : "On-device"}
              </span>
            </div>
            <div className="desk-stat-row" style={{ marginTop: "var(--sp-3)" }}>
              <div className="usage-tile">
                <div className="usage-tile__value mono">{boardCount || "—"}</div>
                <div className="usage-tile__label">Names on board</div>
              </div>
              <div className="usage-tile">
                <div className="usage-tile__value" style={{ fontSize: 16 }}>
                  {lastRun?.finishedAt ? relativeTime(lastRun.finishedAt) : "—"}
                </div>
                <div className="usage-tile__label">Published</div>
              </div>
              <div className="usage-tile">
                <div className="usage-tile__value" style={{ fontSize: 16 }}>
                  Pre-market {String(SCHEDULE_HOUR).padStart(2, "0")}:00
                </div>
                <div className="usage-tile__label">Cadence</div>
              </div>
            </div>
            <p className="text-faint" style={{ fontSize: 12, marginTop: "var(--sp-3)", marginBottom: 0 }}>
              Reopening the app the same day reuses the board — zero quota. Scan Market forces a
              fresh run anytime.
            </p>
          </div>
        </div>

        <div className="col gap-4">
          {/* Live news & price targets (key health) */}
          <div className="ops-card">
            <div className="ops-card__title">Live news &amp; price targets</div>
            <div
              className={`lookup-banner ${finnhubCheck?.status === "ok" ? "lookup-banner--curated" : ""}`}
            >
              {finnhubCheck?.status === "ok" && (
                <>
                  <strong>Finnhub verified.</strong> API accepted your key
                  {finnhubCheck.samplePrice != null && (
                    <> (live test quote: AAPL ${finnhubCheck.samplePrice.toFixed(2)})</>
                  )}
                  . Detail pages load live news and analyst targets.
                </>
              )}
              {finnhubCheck?.status === "missing_key" && (
                <>
                  <strong>Add a Finnhub key</strong> for real lookups: copy{" "}
                  <code className="env-code">.env.example</code> to{" "}
                  <code className="env-code">.env</code>, set{" "}
                  <code className="env-code">VITE_FINNHUB_API_KEY</code>, restart the app.
                </>
              )}
              {finnhubCheck?.status === "invalid_key" && (
                <>
                  <strong>Finnhub key not working.</strong> The key is set but the API rejected it —
                  fix <code className="env-code">.env</code> and restart. {finnhubCheck.detail}
                </>
              )}
              {finnhubCheck?.status === "error" && (
                <>
                  <strong>Finnhub check failed.</strong>{" "}
                  {finnhubCheck.detail ?? "Network or rate limit — try again."}
                </>
              )}
              {!finnhubCheck && isFinnhubConfigured() && <>Checking Finnhub connection…</>}
            </div>
          </div>

          {/* Providers */}
          <div className="ops-card">
            <div className="ops-card__title">Data providers</div>
            <div className="col gap-2">
              {providers.map((p) => (
                <div key={p.id} className="portfolio-pick" style={{ cursor: "default" }}>
                  <div className="col" style={{ alignItems: "flex-start" }}>
                    <span style={{ fontWeight: 600, fontSize: 13.5 }}>{p.name}</span>
                    <span className="text-faint" style={{ fontSize: 12 }}>
                      {p.id === activeProvider.id ? "Active" : "Available"}
                    </span>
                  </div>
                  <span className={`pill ${p.isLive ? "pill--risk-Low" : ""}`}>
                    {p.isLive ? "Live" : "Stub"}
                  </span>
                </div>
              ))}
              <div className="row-between" style={{ marginTop: 4 }}>
                <span className="text-faint" style={{ fontSize: 12 }}>
                  Failover keys
                </span>
                <span className="text-muted" style={{ fontSize: 12, textAlign: "right" }}>
                  {proxied
                    ? "Held server-side by the market proxy"
                    : backups.length > 0
                      ? backups.map((id) => FALLBACK_LABEL[id]).join(" → ")
                      : "None configured"}
                </span>
              </div>
              <p className="text-faint" style={{ fontSize: 11.5, marginTop: 4 }}>
                {proxied
                  ? "Vendor keys (incl. backups) stay server-side on the market proxy — never shipped in this build."
                  : "Switch with VITE_DATA_PROVIDER · keys load from env. Per-source usage & failover detail is on the board above."}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent scans */}
      {runHistory.length > 0 && (
        <div className="ops-card">
          <div className="ops-card__title">Recent scans</div>
          <div className="col gap-2">
            {runHistory.map((r, i) => (
              // Run ids can collide (e.g. two scans tagged the same day) - pair the
              // id with the index so React keys stay unique.
              <div key={`${r.id}-${i}`} className="portfolio-pick" style={{ cursor: "default" }}>
                <div className="row gap-3">
                  <span className={`pill ${r.status === "complete" ? "pill--risk-Low" : "pill--risk-High"}`}>
                    {r.trigger}
                  </span>
                  <span className="text-muted" style={{ fontSize: 13 }}>
                    {r.finishedAt ? relativeTime(r.finishedAt) : "—"}
                  </span>
                </div>
                <span className="text-faint mono" style={{ fontSize: 12 }}>
                  {r.signalsGenerated} signals · {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-faint" style={{ fontSize: 12, margin: "var(--sp-1) 0 0" }}>
        Operator controls — data-source toggles, kill-switches, IC reality checks — live on{" "}
        <Link to="/admin">Operator</Link>.
      </p>
    </section>
  );
}
