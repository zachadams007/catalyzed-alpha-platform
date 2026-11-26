import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "@/components/common/Modal";
import { useGroupsStore } from "@/store/useGroupsStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useAppStore } from "@/store/useAppStore";
import { getSymbol } from "@/data/symbols/symbolDirectory";
import { relativeTime } from "@/lib/format";
import { IconCheck, IconPlus, IconWatchlist } from "@/components/icons";
import { GroupAvatar } from "./shared";
import type { GroupMember, MemberHolding, MemberHoldingSource } from "@/data/groups/types";

/**
 * Member-holdings view (K5). From a group, click a member to see the tickers
 * THEY are surfacing - their shared-group watchlist adds, their calls, and any
 * PUBLIC portfolio holdings - each openable in Ticker Scope. A member's private
 * portfolio is never shown (see 0019_member_holdings.sql); this is only what's
 * already member-visible. If you aren't friends yet but share this group, an
 * "Add friend" action sends the same mutual request the rest of the app uses.
 */

const SOURCE_LABEL: Record<MemberHoldingSource, string> = {
  call: "Called",
  public_portfolio: "Portfolio",
  watchlist: "Watching",
};

function SourceChip({ source }: { source: MemberHoldingSource }) {
  return <span className={`grp-hold__src grp-hold__src--${source}`}>{SOURCE_LABEL[source]}</span>;
}

export function MemberHoldings({
  member,
  groupId,
  onClose,
}: {
  member: GroupMember;
  groupId: string;
  onClose: () => void;
}) {
  const loadMemberHoldings = useGroupsStore((s) => s.loadMemberHoldings);

  const viewerId = useAuthStore((s) => s.userId);
  const friends = useAuthStore((s) => s.friends);
  const outgoing = useAuthStore((s) => s.outgoing);
  const incoming = useAuthStore((s) => s.incoming);
  const addFriend = useAuthStore((s) => s.addFriend);
  const pushToast = useAppStore((s) => s.pushToast);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [holdings, setHoldings] = useState<MemberHolding[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const p = member.profile;
  const label = p.displayName || p.handle || "Member";
  const isSelf = p.id === viewerId;
  const isFriend = friends.some((f) => f.profile.id === p.id);
  const isPending = outgoing.some((r) => r.profile.id === p.id);
  const hasIncoming = incoming.some((r) => r.profile.id === p.id);

  const load = async () => {
    setStatus("loading");
    setError("");
    const r = await loadMemberHoldings(groupId, member.profile.id);
    if (r.ok) {
      setHoldings(r.holdings ?? []);
      setStatus("ready");
    } else {
      setError(r.error ?? "Couldn't load this member's holdings.");
      setStatus("error");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, member.profile.id]);

  const doAdd = async () => {
    setAdding(true);
    const r = await addFriend(p.id);
    setAdding(false);
    if (r.ok) pushToast(`Friend request sent to ${p.handle ? `@${p.handle}` : label}`, "success");
    else pushToast(r.error ?? "Couldn't send request", "warn");
  };

  return (
    <Modal title={`${label}'s holdings`} onClose={onClose} className="grp-hold-modal">
      <div className="grp-hold__head">
        <GroupAvatar profile={p} size={44} />
        <div className="grp-hold__who">
          <span className="grp-hold__name">{label}</span>
          {p.handle && <span className="grp-hold__handle mono">@{p.handle}</span>}
        </div>
        {!isSelf &&
          (isFriend ? (
            <span className="origin-pill origin-pill--friend grp-hold__rel">
              <IconCheck size={13} /> Friends
            </span>
          ) : isPending ? (
            <span className="origin-pill origin-pill--suggested grp-hold__rel">Request sent</span>
          ) : hasIncoming ? (
            <span className="origin-pill origin-pill--suggested grp-hold__rel">Wants to connect</span>
          ) : (
            <button
              className="btn btn--primary btn--sm grp-hold__rel"
              onClick={() => void doAdd()}
              disabled={adding}
            >
              <IconPlus size={14} /> {adding ? "Sending…" : "Add friend"}
            </button>
          ))}
      </div>

      <p className="text-muted grp-hold__lede">
        Tickers {label} is surfacing in groups you share — what they're watching, calling, and
        holding publicly. Not a readout of their private portfolio.
      </p>

      {status === "loading" ? (
        <ul className="grp-hold__list" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <li className="grp-hold grp-hold--skeleton" key={i}>
              <span className="skeleton grp-hold__skel-ticker" />
              <span className="skeleton grp-hold__skel-meta" />
            </li>
          ))}
        </ul>
      ) : status === "error" ? (
        <div className="empty grp-empty grp-hold__state" role="alert">
          <h3>Couldn't load holdings</h3>
          <p>{error}</p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : holdings.length === 0 ? (
        <div className="empty grp-empty grp-hold__state">
          <IconWatchlist size={24} />
          <h3>Nothing shared yet</h3>
          <p>
            {label} hasn't added anything to a shared watchlist, logged a call, or made a portfolio
            public in the groups you share.
          </p>
        </div>
      ) : (
        <ul className="grp-hold__list" role="list">
          {holdings.map((h) => {
            const rec = getSymbol(h.ticker);
            return (
              <li key={`${h.source}-${h.ticker}`} className="grp-hold">
                <Link
                  to={`/signal/${h.ticker}`}
                  className="grp-hold__id"
                  title={rec?.name ?? h.ticker}
                  onClick={onClose}
                >
                  <span className="ticker mono grp-hold__ticker">{h.ticker}</span>
                  {rec?.name && <span className="grp-hold__cname">{rec.name}</span>}
                </Link>
                <div className="grp-hold__meta">
                  <SourceChip source={h.source} />
                  <span className="text-faint grp-hold__time">{relativeTime(h.createdAt)}</span>
                </div>
                {h.note && <p className="grp-hold__note">“{h.note}”</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
