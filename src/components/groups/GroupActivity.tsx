import { useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useGroupsStore } from "@/store/useGroupsStore";
import { useAuthStore } from "@/store/useAuthStore";
import { relativeTime } from "@/lib/format";
import { activitySummary, activityTone, actorName, unreadCount } from "@/data/groups/activity";
import { IconWatchlist } from "@/components/icons";
import { IconBell, IconChat, IconMegaphone, IconPoll } from "./icons";
import { GroupAvatar } from "./shared";
import type { GroupActivity as Activity } from "@/data/groups/types";

function KindIcon({ kind }: { kind: Activity["kind"] }) {
  switch (kind) {
    case "call":
      return <IconMegaphone size={14} />;
    case "watchlist":
      return <IconWatchlist size={14} />;
    case "poll_opened":
    case "poll_closed":
      return <IconPoll size={14} />;
    default:
      return <IconChat size={14} />;
  }
}

/** A live activity / alerts feed for the group, with an unread divider. */
export function GroupActivity({ groupId }: { groupId: string }) {
  const activity = useGroupsStore((s) => s.activity);
  const readMarks = useGroupsStore((s) => s.readMarks);
  const viewerId = useAuthStore((s) => s.userId);
  const now = Date.now();

  // Freeze the read boundary at the moment the tab is opened. Opening the
  // Activity tab calls markGroupRead() (clearing the badge for next time), but
  // within THIS view we still want to show what was new when the user arrived -
  // the "New" divider and the in-panel count reflect the snapshot, not the
  // already-cleared live mark.
  const frozenRead = useRef<string | null | undefined>(undefined);
  if (frozenRead.current === undefined) frozenRead.current = readMarks[groupId] ?? null;
  const lastRead = frozenRead.current;
  const unread = unreadCount(activity, lastRead, viewerId);
  const readSince = lastRead ? new Date(lastRead).getTime() : 0;

  // Index of the first row that is "new" (newer than the read mark and not ours),
  // so we can drop a single "New" divider above it.
  const firstNewIdx = useMemo(() => {
    return activity.findIndex(
      (a) => (!viewerId || a.actor?.id !== viewerId) && new Date(a.createdAt).getTime() > readSince,
    );
  }, [activity, readSince, viewerId]);

  return (
    <section className="grp-panel grp-activity" aria-labelledby="grp-activity-title">
      <header className="grp-panel__head">
        <div className="grp-panel__title" id="grp-activity-title">
          <IconBell size={17} />
          <span>Activity</span>
          {unread > 0 && (
            <span className="grp-activity__unread mono" aria-label={`${unread} unread`}>
              {unread}
            </span>
          )}
        </div>
      </header>

      {activity.length === 0 ? (
        <div className="empty grp-empty">
          <IconBell size={24} />
          <p>Nothing yet. New calls, watchlist adds, and polls will show up here as your group gets going.</p>
        </div>
      ) : (
        <ul className="grp-feed">
          {activity.map((a, i) => {
            const isNew = (!viewerId || a.actor?.id !== viewerId) && new Date(a.createdAt).getTime() > readSince;
            const ticker = a.meta.ticker;
            return (
              <li key={a.id}>
                {i === firstNewIdx && firstNewIdx >= 0 && (
                  <div className="grp-feed__divider" role="separator">
                    <span>New</span>
                  </div>
                )}
                <div className={`grp-feed-row ${isNew ? "grp-feed-row--new" : ""}`}>
                  <span className={`grp-feed-row__dot grp-feed-row__dot--${activityTone(a.kind)}`} aria-hidden="true">
                    <KindIcon kind={a.kind} />
                  </span>
                  <div className="grp-feed-row__body">
                    <p className="grp-feed-row__text">
                      {a.actor && <GroupAvatar profile={a.actor} size={18} />}
                      <span className="grp-feed-row__actor">{actorName(a)}</span>{" "}
                      <span className="grp-feed-row__verb">{activitySummary(a)}</span>
                      {ticker && (a.kind === "call" || a.kind === "watchlist") && (
                        <Link to={`/signal/${ticker}`} className="grp-feed-row__open" title={`Open ${ticker}`}>
                          View
                        </Link>
                      )}
                    </p>
                    <span className="grp-feed-row__time text-faint">{relativeTime(a.createdAt, now)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
