import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TerminalPanel } from "./TerminalPanel";
import { FeedState } from "@/components/common/FeedState";
import { ExternalLink } from "@/components/common/ExternalLink";
import { IconSparkle, IconExternal, IconRefresh } from "@/components/icons";
import {
  runResearchAgent,
  researchAgentStatus,
  ResearchProxyError,
} from "@/data/ai/researchAgent";
import { hostnameOf } from "@/lib/format";
import type { ResearchIntel } from "@/types";

/** Typical round-trip for the grounded agent (Gemini + Groq fallback). Cold
 *  start can be slower; the bar soft-caps at 95% so it never reaches 100%
 *  while still in-flight. */
const BRIEF_TYPICAL_MS = 28_000;

/** Counts elapsed ms since `startedAt` (a Date.now() snapshot), ticking every
 *  200 ms while `active` is true. Mirrors ResearchNarrator's useElapsed. */
function useBriefElapsed(active: boolean, startedAt: number): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Date.now() - startedAt));
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  return elapsed;
}

interface AiBriefPanelProps {
  id?: string;
  ticker: string;
  companyName: string;
}

function sentimentLabel(s: number): { label: string; cls: string } {
  if (s > 0.2) return { label: "Bullish lean", cls: "text-bull" };
  if (s < -0.2) return { label: "Bearish lean", cls: "text-bear" };
  return { label: "Mixed / neutral", cls: "text-muted" };
}

/** The Bull/Bear/Judge debate's headline verdict - the same call the Research Desk
 *  leads with, surfaced here so the in-page brief states bullish/bearish/mixed
 *  outright (not just a sentiment lean). */
function stanceWord(s: "bullish" | "bearish" | "mixed"): string {
  return s === "bullish" ? "Bullish" : s === "bearish" ? "Bearish" : "Mixed";
}

/**
 * AI research brief - the workspace differentiator. Runs the hosted research
 * agent (Gemini 2.5 Flash by default) for a grounded, cited read on the name.
 * Degrades honestly when the proxy is unset or the daily budget is spent.
 */
export function AiBriefPanel({ id, ticker, companyName }: AiBriefPanelProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [intel, setIntel] = useState<ResearchIntel | null>(null);
  const [error, setError] = useState("");
  const [loadStartedAt, setLoadStartedAt] = useState(0);

  const elapsed = useBriefElapsed(status === "loading", loadStartedAt);
  const briefProgress = Math.min(0.95, elapsed / BRIEF_TYPICAL_MS);
  const remainingMs = Math.max(0, BRIEF_TYPICAL_MS - elapsed);
  const etaLabel =
    briefProgress >= 0.93
      ? "almost there…"
      : `~${Math.ceil(remainingMs / 1000)}s left`;

  const lane = researchAgentStatus();

  const generate = (attempt = 0) => {
    const live = researchAgentStatus();
    if (live.lane !== "ready") return;
    setStatus("loading");
    setLoadStartedAt(Date.now());
    setError("");
    // 150s matches the desk - the grounded agent runs on a Supabase Edge Function
    // that can cold-start slowly on the first hit after idle (the brief's old 120s
    // timed out where the desk's 150s didn't, which is why "the desk works but the
    // brief doesn't").
    void runResearchAgent({ task: "deep_research", ticker, companyName }, { timeoutMs: 150_000 })
      .then((res) => {
        setIntel(res);
        setStatus("done");
      })
      .catch((err) => {
        // One automatic retry: the first call after an idle period often just woke
        // the function; the second lands on a warm one.
        if (attempt === 0) {
          window.setTimeout(() => generate(1), 1500);
          return;
        }
        setError(
          err instanceof ResearchProxyError
            ? err.message
            : "The research agent could not be reached.",
        );
        setStatus("error");
      });
  };

  const headerRight =
    status === "done" ? (
      <button className="tw-icon-btn" onClick={() => generate()} title="Regenerate brief" aria-label="Regenerate brief">
        <IconRefresh size={14} />
      </button>
    ) : undefined;

  let body;
  if (lane.lane === "off") {
    body = (
      <FeedState title="AI lane not configured">
        Set <span className="mono">VITE_RESEARCH_PROXY_URL</span> to your hosted research agent to
        get a grounded, cited brief here. Keys stay server-side — the desktop bundle never holds
        them.
      </FeedState>
    );
  } else if (lane.lane === "paused") {
    body = (
      <FeedState title="AI budget paused">
        {lane.reason ?? "The research proxy's daily budget is spent. It resets at local midnight."}
      </FeedState>
    );
  } else if (status === "loading") {
    body = (
      <div className="tw-brief__loading" role="status" aria-busy="true" aria-label={`Researching ${ticker}`}>
        <div className="tw-brief__loading-head">
          <span className="tw-brief__loading-label">
            <span className="tw-brief__loading-dot" aria-hidden="true" />
            Researching <span className="mono">{ticker}</span>…
          </span>
          <span className="tw-brief__loading-eta mono">{etaLabel}</span>
        </div>
        <div className="tw-brief__loading-track" aria-hidden="true">
          <span
            className="tw-brief__loading-fill"
            style={{ width: `${Math.round(briefProgress * 100)}%` }}
          />
        </div>
        <p className="tw-brief__loading-sub">
          Grounding against live data and sources…
        </p>
      </div>
    );
  } else if (status === "error") {
    body = (
      <FeedState
        variant="error"
        title="Brief unavailable"
        action={
          <button className="btn btn--ghost btn--sm" onClick={() => generate()}>
            Retry
          </button>
        }
      >
        {error}
      </FeedState>
    );
  } else if (status === "done" && intel) {
    // Lead with the debate VERDICT (bullish/bearish/mixed + conviction) when the
    // grounded desk lane returned it; otherwise fall back to the sentiment lean.
    const stance = intel.debate?.stance;
    const verdictConf =
      intel.debate?.confidence ?? (typeof intel.confidence === "number" ? intel.confidence : null);
    const sent = !stance && intel.sentiment != null ? sentimentLabel(intel.sentiment) : null;
    body = (
      <div className="tw-brief">
        {stance ? (
          <div className={`tw-brief__verdict tw-brief__verdict--${stance}`}>
            <span className="tw-brief__verdict-dot" aria-hidden="true" />
            <span className="tw-brief__verdict-label">Verdict</span>
            <span className="tw-brief__verdict-stance">{stanceWord(stance)}</span>
            {verdictConf != null ? (
              <span
                className="tw-brief__verdict-conf mono"
                title="Conviction = how strongly the AI holds this call, not the direction. The stance (Bullish/Bearish/Mixed) is which way it leans; conviction is how confident it is in that lean (higher = surer)."
              >
                {Math.round(verdictConf)}% conviction
              </span>
            ) : null}
          </div>
        ) : sent ? (
          <span className={`tw-brief__sentiment ${sent.cls}`}>{sent.label}</span>
        ) : null}
        {intel.summary ? <p className="tw-brief__summary">{intel.summary}</p> : null}

        {(intel.bullPoints?.length || intel.bearPoints?.length) ? (
          <div className="tw-brief__cols">
            {intel.bullPoints?.length ? (
              <div>
                <div className="tw-brief__col-head text-bull">Bull case</div>
                <ul className="tw-brief__list">
                  {intel.bullPoints.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {intel.bearPoints?.length ? (
              <div>
                <div className="tw-brief__col-head text-bear">Bear case</div>
                <ul className="tw-brief__list">
                  {intel.bearPoints.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {intel.citations.length > 0 ? (
          <div className="tw-brief__cites">
            <div className="tw-panel__subhead">Sources</div>
            {intel.citations.map((c) => (
              <ExternalLink key={c.url} href={c.url} className="source-link">
                <IconExternal size={13} />
                <span className="grow">{c.title}</span>
                <span className="text-faint" style={{ fontSize: 11 }}>
                  {hostnameOf(c.url)}
                </span>
              </ExternalLink>
            ))}
          </div>
        ) : null}
        <Link to={`/research?ticker=${encodeURIComponent(ticker)}`} className="tw-brief__deeplink">
          <IconSparkle size={13} />
          <span className="grow">Open full diligence on {ticker}</span>
          <IconExternal size={13} />
        </Link>
        <p className="tw-brief__disclaimer text-faint">
          AI-generated research summary — informational, not advice. Verify against primary sources.
        </p>
      </div>
    );
  } else {
    body = (
      <div className="tw-brief__cta">
        <p className="text-muted">
          One-keystroke grounded read on {ticker} — catalysts, the bull/bear case, and cited
          sources.
        </p>
        <button className="btn btn--primary btn--sm" onClick={() => generate()}>
          <IconSparkle size={15} />
          Generate AI brief
        </button>
      </div>
    );
  }

  return (
    <TerminalPanel
      id={id}
      title="AI brief"
      hint={intel?.model ? <span className="mono">{intel.model}</span> : "grounded research"}
      headerRight={headerRight}
      span="tall"
    >
      {body}
    </TerminalPanel>
  );
}
