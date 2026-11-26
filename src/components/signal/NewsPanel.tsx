import type { NewsItem, StockSignal } from "@/types";
import { ExternalLink } from "@/components/common/ExternalLink";
import { NewsSkeleton } from "@/components/common/NewsSkeleton";
import { IconExternal, IconNews } from "@/components/icons";
import { hostnameOf, relativeTime } from "@/lib/format";
import { isDirectNewsUrl, newsItemHref, yahooQuoteUrl } from "@/lib/links";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";

interface NewsPanelProps {
  signal: StockSignal;
  /** Override items (e.g. live wires on detail). Defaults to signal.news.items. */
  items?: NewsItem[];
  limit?: number;
  variant?: "feed" | "detail";
  showCatalyst?: boolean;
  liveStatus?: "loading" | "live" | "sample";
}

function sentimentTone(sentiment: number): "positive" | "negative" | "neutral" {
  if (sentiment > 0.2) return "positive";
  if (sentiment < -0.2) return "negative";
  return "neutral";
}

function NewsRow({
  item,
  ticker,
  layout,
}: {
  item: NewsItem;
  ticker: string;
  layout: "feed" | "detail";
}) {
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
      {direct && href ? (
        <span className="news-card__action text-faint">
          Read on {hostnameOf(item.url)}
          <IconExternal size={12} />
        </span>
      ) : (
        <span className="news-card__action text-faint">
          {isSampleDataModeEnabled()
            ? "Sample · opens on detail with live wires"
            : "Opens on detail with live wires"}
        </span>
      )}
    </>
  );

  if (direct && href) {
    return (
      <ExternalLink
        className={`news-card news-card--${layout}`}
        href={href}
        title={item.headline}
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </ExternalLink>
    );
  }

  return (
    <div
      className={`news-card news-card--${layout} news-card--static`}
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </div>
  );
}

/** News block with outlet, age, and headline - used on feed cards. */
export function NewsPanel({
  signal,
  items: itemsProp,
  limit,
  variant = "feed",
  showCatalyst = false,
  liveStatus,
}: NewsPanelProps) {
  const base = itemsProp ?? signal.news.items;
  // Detail variant: cap at 6 (most recent, already sorted + deduped upstream).
  // Feed variant: respect the caller's limit, or show all available feed items.
  const effectiveLimit = limit ?? (variant === "detail" ? 6 : undefined);
  const items = effectiveLimit != null ? base.slice(0, effectiveLimit) : base;
  if (items.length === 0 && liveStatus !== "loading") return null;

  const layout = variant === "detail" ? "detail" : "feed";

  return (
    <section className={`news-panel news-panel--${layout}`} aria-label="Recent news">
      <div className="news-panel__head">
        <IconNews className="news-panel__icon" size={18} />
        <div className="grow">
          <div className="news-panel__title">News</div>
          {showCatalyst && (
            <p className="news-panel__catalyst text-muted">{signal.catalyst.description}</p>
          )}
          {liveStatus === "live" && (
            <p className="text-faint" style={{ fontSize: 11.5, marginTop: 4 }}>
              Live article links
            </p>
          )}
        </div>
        <ExternalLink
          className="news-panel__more"
          href={yahooQuoteUrl(signal.ticker)}
          onClick={(e) => e.stopPropagation()}
        >
          Yahoo
          <IconExternal size={12} />
        </ExternalLink>
      </div>
      {liveStatus === "loading" ? (
        <NewsSkeleton rows={limit ?? 2} layout="feed" />
      ) : (
        <div className={`news-panel__list news-panel__list--${layout}`}>
          {items.map((item) => (
            <NewsRow
              key={`${item.url}-${item.publishedAt}`}
              item={item}
              ticker={signal.ticker}
              layout={layout}
            />
          ))}
        </div>
      )}
      {variant === "feed" &&
        !liveStatus &&
        !items.some((n) => isDirectNewsUrl(n.url)) && (
          <p className="news-panel__hint text-faint">
            Scan Market or open {signal.ticker} for live headline links.
          </p>
        )}
    </section>
  );
}
