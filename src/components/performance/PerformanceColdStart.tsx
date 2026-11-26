import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { Skeleton } from "@/components/common/Skeleton";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import {
  IconTarget,
  IconRefresh,
  IconAlertTriangle,
  IconCheck,
  IconPulse,
  IconScale,
} from "@/components/icons";
import { isResearchRunAllowed } from "@/data/providers";
import type { PerformanceSummary } from "@/engine/outcomeLedger";
import "./performance-cold-start.css";

type RevealStyle = CSSProperties & { "--reveal-index"?: number };

interface PerformanceColdStartProps {
  summary: PerformanceSummary;
  isAdmin: boolean;
}

/**
 * Cold-start for Track Record - shows what we'll prove and when, with ghost
 * stat silhouettes and a skeleton CTA (never a bare spinner).
 */
export function PerformanceColdStart({ summary, isAdmin }: PerformanceColdStartProps) {
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  const researchStatus = useAppStore((s) => s.researchStatus);
  const canRun = isResearchRunAllowed();
  const running = researchStatus === "running";
  const runErrored = researchStatus === "error";

  const proofs = [
    {
      icon: <IconPulse size={16} />,
      title: "Hit rate",
      body: "What share of our picks actually rose over 7, 30 and 90 days.",
      ghost: ["62%", "41%", "28%"] as const,
    },
    {
      icon: <IconScale size={16} />,
      title: "Does the score work?",
      body: "Whether higher-rated picks really beat lower-rated ones — rank tier by tier.",
      stair: true,
    },
    {
      icon: <IconTarget size={16} />,
      title: "Best calls & honest misses",
      body: "Our biggest wins — and the ones we got wrong, shown without spin.",
      ghost: ["NVDA +18%", "TERA −9%"] as const,
    },
  ];

  const timeline = [
    { when: "Today", what: "Tracking starts", done: true },
    { when: "+7 days", what: "First 7-day returns land" },
    { when: "+30 / +90", what: "Deeper windows fill in" },
  ];

  return (
    <div className="cs">
      <section className="cs-hero perf-reveal" style={{ "--reveal-index": 0 } as RevealStyle}>
        <span className="cs-hero__badge" aria-hidden="true">
          <IconTarget size={26} />
        </span>
        <h2 className="cs-hero__title">The honest scoreboard is warming up</h2>
        <p className="cs-hero__lede">
          Catalyzed grades every pick on a 0–100 scale, then waits and checks the real price. This is
          where we prove whether the score actually works — <strong>first results in about 7 days.</strong>
        </p>
      </section>

      <section
        className="cs-ghost-stats perf-reveal"
        style={{ "--reveal-index": 1 } as RevealStyle}
        aria-hidden="true"
      >
        {[0, 1, 2, 3].map((i) => (
          <div className="cs-ghost-stat" key={i}>
            <Skeleton width={72} height={10} radius={6} />
            <span className="cs-ghost-stat__value mono">—</span>
            <Skeleton width="80%" height={8} radius={6} style={{ marginTop: 8 }} />
          </div>
        ))}
      </section>

      <section className="cs-proofs perf-reveal" style={{ "--reveal-index": 2 } as RevealStyle} aria-label="What this scoreboard will prove">
        {proofs.map((p, i) => (
          <article className="cs-proof" key={p.title} style={{ "--reveal-index": i } as RevealStyle}>
            <span className="cs-proof__icon" aria-hidden="true">
              {p.icon}
            </span>
            <h3 className="cs-proof__title">{p.title}</h3>
            <p className="cs-proof__body">{p.body}</p>
            {p.stair && (
              <div className="cs-ghost-stair" aria-hidden="true">
                {[28, 44, 40, 62, 78].map((h, j) => (
                  <span
                    className="cs-ghost-stair__bar"
                    key={j}
                    style={{ height: `${h}%`, "--reveal-index": j } as RevealStyle}
                  />
                ))}
              </div>
            )}
            {p.ghost && (
              <div className="cs-ghost-chips" aria-hidden="true">
                {p.ghost.map((chip) => (
                  <span className="cs-ghost-chip mono" key={chip}>
                    {chip}
                  </span>
                ))}
              </div>
            )}
          </article>
        ))}
      </section>

      <section
        className="cs-timeline perf-reveal"
        style={{ "--reveal-index": 3 } as RevealStyle}
        aria-label="When results arrive"
      >
        <ol className="cs-timeline__track">
          {timeline.map((t) => (
            <li className={`cs-tl${t.done ? " cs-tl--done" : ""}`} key={t.when}>
              <span className="cs-tl__dot" aria-hidden="true">
                {t.done ? <IconCheck size={12} /> : null}
              </span>
              <span className="cs-tl__when mono">{t.when}</span>
              <span className="cs-tl__what">{t.what}</span>
            </li>
          ))}
        </ol>
      </section>

      {runErrored ? (
        <div className="ops-banner ops-banner--error cs-banner perf-reveal" style={{ "--reveal-index": 4 } as RevealStyle} role="alert">
          <IconAlertTriangle size={16} />
          <span>
            The last research run couldn&apos;t reach the data source. No outcomes were recorded — try
            again.
          </span>
        </div>
      ) : (
        <p className="cs-note text-faint perf-reveal" style={{ "--reveal-index": 4 } as RevealStyle}>
          {summary.coverageNote}
        </p>
      )}

      <div className="cs-cta perf-reveal" style={{ "--reveal-index": 5 } as RevealStyle}>
        {canRun ? (
          <button
            className="btn btn--primary cs-cta__btn"
            disabled={running}
            onClick={() => runResearchNow("manual")}
            aria-busy={running}
          >
            {running ? (
              <>
                <span className="cs-cta__skel" aria-hidden="true">
                  <Skeleton width={15} height={15} radius={4} />
                </span>
                <span className="cs-cta__label">Scanning…</span>
              </>
            ) : (
              <>
                <IconRefresh size={15} />
                {runErrored ? "Try again" : "Scan market now"}
              </>
            )}
          </button>
        ) : isAdmin ? (
          <p className="text-faint cs-cta__hint">
            Turn on data access in the <Link to="/admin">Operator Console</Link> to start tracking.
          </p>
        ) : (
          <p className="text-faint cs-cta__hint">
            Tracking begins automatically on the next research run.
          </p>
        )}
      </div>

      <div className="perf-reveal" style={{ "--reveal-index": 6 } as RevealStyle}>
        <InvestingDisclaimer className="page-disclaimer" />
      </div>
    </div>
  );
}
