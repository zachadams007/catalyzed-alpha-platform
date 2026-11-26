import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/common/Skeleton";
import {
  IconArrowUp,
  IconCheck,
  IconPlus,
  IconPortfolios,
  IconRefresh,
} from "@/components/icons";
import "./portfolio-desk-empty.css";

type RevealStyle = CSSProperties & { "--reveal-index"?: number };

const PREVIEW_ALLOC = [38, 22, 18, 12, 10];

interface PortfolioDeskEmptyStateProps {
  onCreate: () => void;
}

/**
 * Cold-start for the Portfolios tab - an inspiring preview of the desk console,
 * allocation cards, and vitals that light up once the user adds their first book.
 */
export function PortfolioDeskEmptyState({ onCreate }: PortfolioDeskEmptyStateProps) {
  const steps = [
    { when: "Step 1", what: "Create a themed book", done: true },
    { when: "Step 2", what: "Add holdings from any feed card" },
    { when: "Step 3", what: "Scan Market for live valuation" },
  ];

  const surfaces = [
    {
      title: "Desk console",
      body: "Total market value, today's move, and avg opportunity score across every book you own.",
    },
    {
      title: "Allocation & vitals",
      body: "Value-weighted slices, best/worst movers, and a progression chart once shares are in.",
    },
    {
      title: "Research overlay",
      body: "Every holding re-scored on each research run — discovery context beside your positions.",
    },
  ];

  return (
    <div className="pf-cold" aria-label="Your portfolios will appear here">
      <section className="pf-cold__hero pf-reveal" style={{ "--reveal-index": 0 } as RevealStyle}>
        <span className="pf-cold__badge" aria-hidden="true">
          <IconPortfolios size={26} />
        </span>
        <h2 className="pf-cold__title">Your desk is ready for its first book</h2>
        <p className="pf-cold__lede">
          Curate stocks into themed, playlist-style portfolios. Once holdings are in, this tab becomes
          a live research console — <strong>market value, allocation, and scores side by side.</strong>
        </p>
      </section>

      <section
        className="pf-cold__ghost pf-reveal"
        style={{ "--reveal-index": 1 } as RevealStyle}
        aria-hidden="true"
      >
        <div className="pf-cold__ghost-desk">
          <div className="pf-cold__ghost-desk-head">
            <span className="pf-cold__ghost-lamp" />
            <Skeleton width={72} height={10} radius={6} />
            <Skeleton width={140} height={9} radius={6} style={{ marginLeft: "auto" }} />
          </div>
          <div className="pf-cold__ghost-metrics">
            <div className="pf-cold__ghost-metric pf-cold__ghost-metric--hero">
              <Skeleton width={88} height={9} radius={6} />
              <span className="pf-cold__ghost-value mono">$—</span>
            </div>
            <div className="pf-cold__ghost-metric">
              <Skeleton width={42} height={9} radius={6} />
              <span className="pf-cold__ghost-row mono text-faint">
                <IconArrowUp size={14} />
                —
              </span>
            </div>
            <div className="pf-cold__ghost-metric">
              <Skeleton width={36} height={9} radius={6} />
              <span className="pf-cold__ghost-value mono">0</span>
            </div>
            <div className="pf-cold__ghost-metric">
              <Skeleton width={96} height={9} radius={6} />
              <span className="pf-cold__ghost-value mono">
                —<span className="pf-cold__ghost-denom">/100</span>
              </span>
            </div>
          </div>
        </div>

        <div className="pf-cold__ghost-cards">
          {[0, 1].map((i) => (
            <article className="pf-cold__ghost-card" key={i} style={{ "--reveal-index": i } as RevealStyle}>
              <Skeleton width="42%" height={10} radius={6} />
              <Skeleton width="68%" height={16} radius={8} style={{ marginTop: 10 }} />
              <Skeleton width="92%" height={10} radius={6} style={{ marginTop: 8 }} />
              <div className="pf-cold__ghost-alloc">
                {PREVIEW_ALLOC.map((w, j) => (
                  <span
                    className="pf-cold__ghost-alloc-seg"
                    key={j}
                    style={{ width: `${w}%`, "--seg-index": j } as RevealStyle}
                  />
                ))}
              </div>
              <div className="pf-cold__ghost-chips">
                <Skeleton width={44} height={22} radius={999} />
                <Skeleton width={40} height={22} radius={999} />
                <Skeleton width={48} height={22} radius={999} />
              </div>
            </article>
          ))}
        </div>
      </section>

      <section
        className="pf-cold__surfaces pf-reveal"
        style={{ "--reveal-index": 2 } as RevealStyle}
        aria-label="What unlocks once you add holdings"
      >
        {surfaces.map((s) => (
          <article className="pf-cold__surface" key={s.title}>
            <h3 className="pf-cold__surface-title">{s.title}</h3>
            <p className="pf-cold__surface-body">{s.body}</p>
          </article>
        ))}
      </section>

      <section
        className="pf-cold__timeline pf-reveal"
        style={{ "--reveal-index": 3 } as RevealStyle}
        aria-label="How to get started"
      >
        <ol className="pf-cold__track">
          {steps.map((t) => (
            <li className={`pf-cold__step${t.done ? " pf-cold__step--done" : ""}`} key={t.when}>
              <span className="pf-cold__step-dot" aria-hidden="true">
                {t.done ? <IconCheck size={12} /> : null}
              </span>
              <span className="pf-cold__step-when mono">{t.when}</span>
              <span className="pf-cold__step-what">{t.what}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="pf-cold__cta pf-reveal" style={{ "--reveal-index": 4 } as RevealStyle}>
        <button type="button" className="btn btn--primary" onClick={onCreate}>
          <IconPlus size={16} />
          Create your first book
        </button>
        <Link className="btn btn--ghost" to="/today">
          Browse Today
          <span className="text-faint"> — add from any card</span>
        </Link>
      </div>

      <p className="pf-cold__hint text-faint pf-reveal" style={{ "--reveal-index": 5 } as RevealStyle}>
        <IconRefresh size={13} />
        After holdings are in, run <strong>Scan Market</strong> from the top bar to value books by live price.
      </p>
    </div>
  );
}
