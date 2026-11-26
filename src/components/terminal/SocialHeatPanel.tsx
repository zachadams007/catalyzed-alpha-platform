import { useEffect, useState } from "react";
import { TerminalPanel } from "./TerminalPanel";
import { FeedState } from "@/components/common/FeedState";
import { Skeleton } from "@/components/common/Skeleton";
import { fetchApeWisdomMention, type ApeWisdomMention } from "@/data/social/apewisdom";
import { fetchStockTwitsSocial, type LiveSocial } from "@/data/social/stocktwits";
import { formatPct } from "@/lib/format";

interface SocialHeatPanelProps {
  id?: string;
  ticker: string;
}

interface Cell {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}

/**
 * Live, keyless retail-attention read: Reddit/WSB mentions (ApeWisdom) +
 * StockTwits message volume & sentiment. Discovery only; degrades to an empty
 * state when neither source is discussing the name.
 */
export function SocialHeatPanel({ id, ticker }: SocialHeatPanelProps) {
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [ape, setApe] = useState<ApeWisdomMention | null>(null);
  const [twits, setTwits] = useState<LiveSocial | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setApe(null);
    setTwits(null);
    Promise.allSettled([fetchApeWisdomMention(ticker), fetchStockTwitsSocial(ticker)])
      .then(([a, t]) => {
        if (cancelled) return;
        if (a.status === "fulfilled") setApe(a.value);
        if (t.status === "fulfilled") setTwits(t.value);
        setStatus("done");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  let body;
  if (status === "loading") {
    body = (
      <div className="kfs" style={{ gridTemplateColumns: "repeat(2, 1fr)" }} aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div className="kf" key={i}>
            <Skeleton height={10} width="60%" />
            <Skeleton height={16} width="40%" style={{ marginTop: 6 }} />
          </div>
        ))}
      </div>
    );
  } else if (status === "error") {
    body = <FeedState variant="error" title="Couldn’t reach social sources" />;
  } else if (!ape && !twits) {
    body = (
      <FeedState title="No social chatter">
        Neither WallStreetBets nor StockTwits is actively discussing {ticker} right now.
      </FeedState>
    );
  } else {
    const cells: Cell[] = [];
    if (ape) {
      cells.push({ label: "Reddit mentions 24h", value: ape.mentions.toLocaleString("en-US") });
      if (ape.rank != null) cells.push({ label: "WSB rank", value: `#${ape.rank}` });
      if (ape.mentions24hAgo != null && ape.mentions24hAgo > 0) {
        const delta = (ape.mentions - ape.mentions24hAgo) / ape.mentions24hAgo;
        cells.push({
          label: "Mentions Δ 24h",
          value: formatPct(delta),
          tone: delta >= 0 ? "positive" : "negative",
        });
      }
    }
    if (twits) {
      cells.push({
        label: "StockTwits msgs",
        value: twits.social.xMentions24h.toLocaleString("en-US"),
      });
      const sent = twits.social.sentiment;
      cells.push({
        label: "StockTwits sentiment",
        value: sent > 0 ? `+${(sent * 100).toFixed(0)}%` : `${(sent * 100).toFixed(0)}%`,
        tone: sent >= 0 ? "positive" : "negative",
      });
      if (twits.watchlistCount) {
        cells.push({
          label: "Watching",
          value: twits.watchlistCount.toLocaleString("en-US"),
        });
      }
    }

    body = (
      <>
        <div className="kfs" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          {cells.map((c) => (
            <div className="kf" key={c.label}>
              <div className="kf__label">{c.label}</div>
              <div className={`kf__value mono ${c.tone ? `kf__value--${c.tone}` : ""}`}>
                {c.value}
              </div>
            </div>
          ))}
        </div>
        {twits?.social.summary ? (
          <p className="text-faint" style={{ fontSize: 12, marginTop: 10 }}>
            {twits.social.summary}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <TerminalPanel id={id} title="Social heat" hint="ApeWisdom · StockTwits">
      {body}
    </TerminalPanel>
  );
}
