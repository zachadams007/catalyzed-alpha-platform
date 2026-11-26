import { useEffect, useState } from "react";
import type { NewsItem } from "@/types";
import { fetchLiveNews } from "@/data/news/liveNews";
import { ExternalLink } from "@/components/common/ExternalLink";
import { Skeleton } from "@/components/common/Skeleton";
import { IconNews, IconExternal, IconRefresh } from "@/components/icons";
import { hostnameOf, relativeTime } from "@/lib/format";
import { pooledMap } from "@/lib/concurrency";

interface TaggedNews extends NewsItem {
  ticker: string;
}

/** Live headlines across every holding in the portfolio. */
export function PortfolioNewsPanel({ tickers }: { tickers: string[] }) {
  const [items, setItems] = useState<TaggedNews[] | null>(null);
  const [errored, setErrored] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const key = tickers.join(",");

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setErrored(false);
    const symbols = tickers.slice(0, 10);
    if (symbols.length === 0) {
      setItems([]);
      return;
    }
    void pooledMap(symbols, 4, async (ticker) => {
      try {
        const news = await fetchLiveNews(ticker);
        return { items: news.slice(0, 3).map((n) => ({ ...n, ticker })), ok: true };
      } catch {
        return { items: [] as TaggedNews[], ok: false };
      }
    })
      .then((results) => {
        if (cancelled) return;
        // Distinguish "no news" from "every fetch failed" so the panel can show
        // an honest error + retry rather than a misleading empty state.
        if (symbols.length > 0 && results.every((r) => !r.ok)) {
          setErrored(true);
          setItems([]);
          return;
        }
        const merged = results
          .flatMap((r) => r.items)
          .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
          .slice(0, 16);
        setItems(merged);
      })
      .catch(() => {
        if (!cancelled) {
          setErrored(true);
          setItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="pf-panel pf-news" aria-label="Portfolio news">
      <div className="pf-panel__head">
        <IconNews size={17} />
        <span className="pf-panel__title">News across your holdings</span>
        {items && items.length > 0 && (
          <span className="pf-panel__hint text-faint">{items.length} stories</span>
        )}
      </div>

      {items === null ? (
        <div className="pf-news__list" aria-busy="true" aria-label="Loading headlines">
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="pf-news__row pf-news__row--skeleton" key={i}>
              <Skeleton width={42} height={20} radius={6} />
              <div className="grow pf-news__skel-lines">
                <Skeleton width="90%" height={13} />
                <Skeleton width="40%" height={10} />
              </div>
            </div>
          ))}
        </div>
      ) : errored ? (
        <div className="pf-news__state pf-news__state--error" role="alert">
          <p>Couldn't load live headlines just now.</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            <IconRefresh size={14} />
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="pf-news__empty text-faint">
          No live headlines for these tickers right now. Headlines appear for live US-listed
          symbols; scan the market or check back later.
        </p>
      ) : (
        <div className="pf-news__list">
          {items.map((item) => (
            <ExternalLink
              key={`${item.ticker}-${item.url}-${item.publishedAt}`}
              href={item.url}
              className="pf-news__row"
              title={item.headline}
            >
              <span className="pf-news__chip">{item.ticker}</span>
              <div className="grow">
                <p className="pf-news__headline">{item.headline}</p>
                <span className="pf-news__meta text-faint">
                  {hostnameOf(item.url)} · {relativeTime(item.publishedAt)}
                  <IconExternal size={11} />
                </span>
              </div>
            </ExternalLink>
          ))}
        </div>
      )}
    </section>
  );
}
