import { useState, type ReactNode } from "react";
import type { StockSignal } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { isMarketDataUnavailable } from "@/lib/marketData";
import { AddToPortfolioModal } from "@/components/portfolio/AddToPortfolioModal";
import { ShareSignalModal } from "@/components/signal/ShareSignalModal";
import { CalloutToGroupModal } from "@/components/signal/CalloutToGroupModal";
import {
  IconArrowDown,
  IconArrowUp,
  IconBookmark,
  IconBookmarkFilled,
  IconClock,
  IconHeart,
  IconHeartFilled,
  IconLayers,
  IconMega,
  IconMinus,
  IconPlus,
  IconScale,
  IconShare,
  IconTarget,
} from "@/components/icons";

function Act({
  icon,
  label,
  title,
  onClick,
  className,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`act-btn ${className ?? ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function ActionBar({
  signal,
  enableTuning = true,
}: {
  signal: StockSignal;
  /** Show the "Tune" + "Time scale" personalization controls. The curated feed
   *  tiles (Today / Weekly / Friends) pass false so only For You - and the focused
   *  stock page - expose tuning (D2). Defaults true to preserve the stock page. */
  enableTuning?: boolean;
}) {
  const liked = useAppStore((s) => s.preferences.likedTickers.includes(signal.ticker));
  const watched = useAppStore((s) => s.watchlist.includes(signal.ticker));
  const toggleLike = useAppStore((s) => s.toggleLike);
  const toggleWatchlist = useAppStore((s) => s.toggleWatchlist);
  const recordInteraction = useAppStore((s) => s.recordInteraction);

  const [showPortfolio, setShowPortfolio] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showCallout, setShowCallout] = useState(false);
  // No live data → the sector / cap / catalyst / horizon dims are unknown, so the
  // "Tune" personalization controls would both display a fabricated sector and
  // teach the feed on dimensions we can't stand behind. Hide them; keep the
  // primary per-ticker actions (like / watch / portfolio / share).
  const noData = isMarketDataUnavailable(signal);

  return (
    <>
      <div className="action-bar">
        <Act
          icon={liked ? <IconHeartFilled /> : <IconHeart />}
          label={liked ? "Liked" : "Like"}
          title="Like this stock"
          className={liked ? "is-active" : ""}
          onClick={() => toggleLike(signal)}
        />
        <Act
          icon={watched ? <IconBookmarkFilled /> : <IconBookmark />}
          label={watched ? "Saved" : "Watch"}
          title="Save to watchlist"
          className={watched ? "is-active-save" : ""}
          onClick={() => toggleWatchlist(signal)}
        />
        <Act
          icon={<IconLayers />}
          label="Portfolio"
          title="Add to portfolio"
          onClick={() => setShowPortfolio(true)}
        />
        <Act
          icon={<IconShare />}
          label="Share"
          title="Share to friends or a group"
          onClick={() => setShowShare(true)}
        />
        <Act
          icon={<IconMega />}
          label="Call out"
          title="Call out this stock to a group's leaderboard"
          onClick={() => setShowCallout(true)}
        />

        {!noData && enableTuning && (
          <>
            <span className="act-divider" />
            <span className="act-group-label">Tune</span>

            <Act
              icon={<IconPlus />}
              label="More like this"
              title="Show me more like this"
              onClick={() => recordInteraction("more_like_this", signal)}
            />
            <Act
              icon={<IconMinus />}
              label="Less like this"
              title="Show me less like this"
              onClick={() => recordInteraction("less_like_this", signal)}
            />
            <Act
              icon={<IconArrowUp />}
              label="Higher cap"
              title="Higher market cap"
              onClick={() => recordInteraction("higher_market_cap", signal)}
            />
            <Act
              icon={<IconArrowDown />}
              label="Lower cap"
              title="Lower market cap"
              onClick={() => recordInteraction("lower_market_cap", signal)}
            />
            <Act
              icon={<IconPlus />}
              label={`More ${signal.sector}`}
              title="More from this sector"
              onClick={() => recordInteraction("more_sector", signal)}
            />
            <Act
              icon={<IconMinus />}
              label={`Less ${signal.sector}`}
              title="Less from this sector"
              onClick={() => recordInteraction("less_sector", signal)}
            />
            <Act
              icon={<IconTarget />}
              label="Catalyst-driven"
              title="More catalyst-driven"
              onClick={() => recordInteraction("more_catalyst_driven", signal)}
            />
            <Act
              icon={<IconScale />}
              label="Fundamentals-driven"
              title="More fundamentals-driven"
              onClick={() => recordInteraction("more_fundamentals_driven", signal)}
            />

            <span className="act-divider" />
            <span className="act-group-label">Time scale</span>

            <Act
              icon={<IconClock />}
              label="Shorter term"
              title="Lean shorter-term (e.g. day trades)"
              onClick={() => recordInteraction("shorter_horizon", signal)}
            />
            <Act
              icon={<IconClock />}
              label="Longer term"
              title="Lean longer-term (e.g. position trades)"
              onClick={() => recordInteraction("longer_horizon", signal)}
            />
          </>
        )}
      </div>

      {showPortfolio && (
        <AddToPortfolioModal signal={signal} onClose={() => setShowPortfolio(false)} />
      )}
      {showShare && <ShareSignalModal signal={signal} onClose={() => setShowShare(false)} />}
      {showCallout && <CalloutToGroupModal signal={signal} onClose={() => setShowCallout(false)} />}
    </>
  );
}
