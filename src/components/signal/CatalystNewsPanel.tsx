import { NewsSkeleton } from "@/components/common/NewsSkeleton";
import type { NewsItem, StockSignal } from "@/types";
import { ExternalLink } from "@/components/common/ExternalLink";
import { CatalystPill } from "@/components/common/Badges";
import { IconExternal, IconNews } from "@/components/icons";
import { hostnameOf, relativeTime } from "@/lib/format";
import { isDirectNewsUrl, newsItemHref, yahooQuoteUrl } from "@/lib/links";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { isMarketDataUnavailable } from "@/lib/marketData";

interface CatalystNewsPanelProps {
  signal: StockSignal;
  items: NewsItem[];
  liveStatus: "loading" | "live" | "sample";
}

function sentimentTone(sentiment: number): "positive" | "negative" | "neutral" {
  if (sentiment > 0.2) return "positive";
  if (sentiment < -0.2) return "negative";
  return "neutral";
}

function NewsRow({ item, ticker }: { item: NewsItem; ticker: string }) {
  const tone = sentimentTone(item.sentiment);
  const href = newsItemHref(ticker, item.url);
  const direct = isDirectNewsUrl(item.url);

  const body = (
    <>
      <div className="news-card__source-row">
        <span className="news-card__source">{item.source}</span>
        <span className="news-card__time">{relativeTime(item.publishedAt)}</span>
        <span className={`news-card__sentiment news-card__sentiment--${tone}`} aria-hidden />
      </div>
      <p className="news-card__headline">{item.headline}</p>
      {direct ? (
        <span className="news-card__action text-faint">
          Read on {hostnameOf(item.url)}
          <IconExternal size={12} />
        </span>
      ) : (
        <span className="news-card__action text-faint">
          {isSampleDataModeEnabled()
            ? "Sample headline — no live article URL"
            : "No direct article link — opens search"}
        </span>
      )}
    </>
  );

  if (direct && href) {
    return (
      <ExternalLink className="news-card news-card--detail" href={href} title={item.headline}>
        {body}
      </ExternalLink>
    );
  }

  return <div className="news-card news-card--detail news-card--static">{body}</div>;
}

/** Combined catalyst context + live (or sample) news on the stock detail page. */
export function CatalystNewsPanel({ signal, items, liveStatus }: CatalystNewsPanelProps) {
  // No live data → no real catalyst to characterize; show only the honest note.
  const noData = isMarketDataUnavailable(signal);
  const catalystWhen =
    signal.catalyst.daysAway < 0
      ? `${Math.abs(signal.catalyst.daysAway)}d ago`
      : signal.catalyst.daysAway === 0
        ? "Today"
        : `in ${signal.catalyst.daysAway} days`;

  return (
    <section className="catalyst-news" aria-label="Catalyst and news">
      <div className="catalyst-news__catalyst">
        <div className="section-title">Catalyst & News</div>
        {!noData && (
          <div className="row gap-2" style={{ marginBottom: 10 }}>
            <CatalystPill type={signal.catalystType} />
            <span className="text-muted" style={{ fontSize: 13 }}>
              {catalystWhen}
            </span>
          </div>
        )}
        <p className="thesis" style={{ fontSize: 14, marginBottom: 0 }}>
          {signal.catalyst.description}
        </p>
      </div>

      <div className="catalyst-news__divider" />

      <div className="catalyst-news__news">
        <div className="news-panel__head" style={{ marginBottom: 12 }}>
          <IconNews className="news-panel__icon" size={18} />
          <div className="grow">
            <div className="news-panel__title">Headlines</div>
            {liveStatus === "loading" && (
              <span className="sr-only">Loading live wires</span>
            )}
            {liveStatus === "live" && (
              <p className="text-faint" style={{ fontSize: 12, marginTop: 4 }}>
                Live articles from Yahoo Finance
                {import.meta.env.VITE_FINNHUB_API_KEY ? " / Finnhub" : ""}.
              </p>
            )}
            {liveStatus === "sample" && (
              <p className="text-faint" style={{ fontSize: 12, marginTop: 4 }}>
                {signal.ticker} is sample data — use{" "}
                <LinkishQuote ticker={signal.ticker} /> or add{" "}
                <code style={{ fontSize: 11 }}>VITE_FINNHUB_API_KEY</code> for live URLs.
              </p>
            )}
          </div>
          <ExternalLink className="news-panel__more" href={yahooQuoteUrl(signal.ticker)}>
            Yahoo Finance
            <IconExternal size={12} />
          </ExternalLink>
        </div>

        {liveStatus === "loading" ? (
          <NewsSkeleton rows={4} layout="detail" />
        ) : items.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 13 }}>No headlines available for this symbol.</p>
        ) : (
          <div className="news-panel__list news-panel__list--detail">
            {items.slice(0, 6).map((item) => (
              <NewsRow key={`${item.url}-${item.publishedAt}`} item={item} ticker={signal.ticker} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function LinkishQuote({ ticker }: { ticker: string }) {
  return (
    <ExternalLink href={yahooQuoteUrl(ticker)} style={{ fontWeight: 600 }}>
      a real ticker
    </ExternalLink>
  );
}
