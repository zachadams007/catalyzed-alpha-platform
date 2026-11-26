import type { ReactNode } from "react";
import {
  FEED_TAB_LABELS,
  FEED_TAB_SUBTITLES,
  type FeedTabId,
} from "@/feed/feeds";
import { RegimeBanner } from "@/components/feed/RegimeBanner";

interface FeedTabHeaderProps {
  feed: FeedTabId;
  /** Override the default algorithm-accurate subtitle (e.g. loading copy). */
  description?: string;
  action?: ReactNode;
}

/**
 * Page header for a feed tab - title plus a one-line explanation of what the
 * tab shows. Mirrors the shared `.page-head` typography, but lays the title and
 * its optional action out so neither is ever clipped at any width: the
 * title/description column can shrink and wrap (`min-width: 0`), and a long
 * action wraps onto its own line instead of overflowing the `overflow-x: clip`
 * content column.
 */
export function FeedTabHeader({ feed, description, action }: FeedTabHeaderProps) {
  return (
    <>
      {/* Panic-mode notification (P9) - renders only when the scan-time regime
          actually shifted the ranking; silent on a normal day. */}
      <RegimeBanner />
      <div className="page-head feed-tab-header">
        <div className="feed-tab-header__lead">
          <h1>{FEED_TAB_LABELS[feed]}</h1>
          <p>{description ?? FEED_TAB_SUBTITLES[feed]}</p>
        </div>
        {action && <div className="feed-tab-header__action">{action}</div>}
      </div>
    </>
  );
}
