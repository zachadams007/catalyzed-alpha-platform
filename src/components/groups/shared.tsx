import { useMemo, useRef, useState } from "react";
import { Popover } from "@/components/common/Popover";
import { initialsFromLabel } from "@/lib/profileDisplay";
import { resolveSymbol } from "@/data/symbols/symbolDirectory";
import { formatPrice, formatPct } from "@/lib/format";
import type { Profile } from "@/data/supabase/friends";
import type { GroupMember, GroupRole } from "@/data/groups/types";
import { useAuthStore } from "@/store/useAuthStore";
import { useAppStore } from "@/store/useAppStore";

/** Round avatar with brand-consistent initials + per-person accent. */
export function GroupAvatar({
  profile,
  size = 34,
  title,
}: {
  profile: Profile;
  size?: number;
  title?: string;
}) {
  const label = profile.displayName || profile.handle || "??";
  return (
    <span
      className="avatar grp-avatar"
      style={{ width: size, height: size, background: profile.avatarAccent, fontSize: Math.round(size * 0.4) }}
      title={title ?? label}
      aria-hidden="true"
    >
      {initialsFromLabel(label)}
    </span>
  );
}

/** Mini popover shown when clicking a member avatar in the stack. */
function MemberPopover({
  member,
  onClose,
  onViewHoldings,
}: {
  member: GroupMember;
  onClose: () => void;
  /** Open the member-holdings view for this member (K5). Optional so the popover
   *  still works in contexts without a holdings surface. */
  onViewHoldings?: (member: GroupMember) => void;
}) {
  const friends = useAuthStore((s) => s.friends);
  const outgoing = useAuthStore((s) => s.outgoing);
  const incoming = useAuthStore((s) => s.incoming);
  const viewerId = useAuthStore((s) => s.userId);
  const addFriend = useAuthStore((s) => s.addFriend);
  const pushToast = useAppStore((s) => s.pushToast);
  const [adding, setAdding] = useState(false);
  const p = member.profile;

  const isSelf = p.id === viewerId;
  const isFriend = friends.some((f) => f.profile.id === p.id);
  const isPending = outgoing.some((r) => r.profile.id === p.id);
  const hasIncoming = incoming.some((r) => r.profile.id === p.id);
  const label = p.displayName || p.handle || "Member";

  const doAdd = async () => {
    setAdding(true);
    const r = await addFriend(p.id);
    setAdding(false);
    if (r.ok) {
      pushToast(`Friend request sent to ${p.handle ? `@${p.handle}` : label}`, "success");
      onClose();
    } else {
      pushToast(r.error ?? "Couldn't send request", "warn");
    }
  };

  return (
    <div className="grp-member-pop">
      <GroupAvatar profile={p} size={36} />
      <span className="grp-member-pop__name">{label}</span>
      {p.handle && <span className="grp-member-pop__handle">@{p.handle}</span>}
      {onViewHoldings && (
        <button
          className="btn btn--ghost btn--sm grp-member-pop__holdings"
          onClick={() => {
            onClose();
            onViewHoldings(member);
          }}
          style={{ width: "100%" }}
        >
          View holdings
        </button>
      )}
      {!isSelf && (
        isFriend ? (
          <span className="origin-pill origin-pill--friend" style={{ fontSize: "var(--type-xs)" }}>Friends</span>
        ) : isPending ? (
          <span className="origin-pill origin-pill--suggested" style={{ fontSize: "var(--type-xs)" }}>Request sent</span>
        ) : hasIncoming ? (
          <span className="origin-pill origin-pill--suggested" style={{ fontSize: "var(--type-xs)" }}>Wants to connect</span>
        ) : (
          <button
            className="btn btn--primary btn--sm"
            onClick={() => void doAdd()}
            disabled={adding}
            style={{ width: "100%" }}
          >
            {adding ? "Sending…" : "Add friend"}
          </button>
        )
      )}
    </div>
  );
}

function MemberStackItem({
  member,
  open,
  viewerId,
  onToggle,
  onClose,
  onViewHoldings,
}: {
  member: GroupMember;
  open: boolean;
  viewerId?: string | null;
  onToggle: () => void;
  onClose: () => void;
  onViewHoldings?: (member: GroupMember) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const label = member.profile.displayName || member.profile.handle || "member";

  return (
    <span className="grp-stack__item">
      <button
        ref={anchorRef}
        className="grp-stack__avatar-btn"
        onClick={onToggle}
        aria-label={`View ${label}`}
        aria-expanded={open}
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
      >
        <GroupAvatar profile={member.profile} size={30} />
      </button>
      {viewerId !== undefined && (
        <Popover
          anchorRef={anchorRef}
          open={open}
          onClose={onClose}
          placement="top"
          role="dialog"
          ariaLabel={`${label} profile`}
        >
          <MemberPopover
            member={member}
            onClose={onClose}
            onViewHoldings={onViewHoldings}
          />
        </Popover>
      )}
    </span>
  );
}

/** Overlapping avatar stack with a "+N" overflow chip. Avatars are clickable to show a mini friend popover. */
export function MemberStack({
  members,
  max = 5,
  viewerId,
  onViewHoldings,
}: {
  members: GroupMember[];
  max?: number;
  viewerId?: string | null;
  /** Open a member's holdings view from the popover (K5). */
  onViewHoldings?: (member: GroupMember) => void;
}) {
  const shown = members.slice(0, max);
  const extra = members.length - shown.length;
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="grp-stack" aria-label={`${members.length} members`}>
      {shown.map((m) => (
        <MemberStackItem
          key={m.membershipId}
          member={m}
          open={openId === m.profile.id}
          viewerId={viewerId}
          onToggle={() => setOpenId(openId === m.profile.id ? null : m.profile.id)}
          onClose={() => setOpenId(null)}
          onViewHoldings={onViewHoldings}
        />
      ))}
      {extra > 0 && <span className="grp-stack__more mono">+{extra}</span>}
    </div>
  );
}

const ROLE_LABEL: Record<GroupRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function RoleBadge({ role }: { role: GroupRole }) {
  if (role === "member") return null;
  return <span className={`grp-role grp-role--${role}`}>{ROLE_LABEL[role]}</span>;
}

/** Signed, colored return. Renders an honest dash when there's no value yet. */
export function ReturnValue({
  ratio,
  className = "",
}: {
  ratio: number | null | undefined;
  className?: string;
}) {
  if (ratio == null || !Number.isFinite(ratio)) {
    return <span className={`grp-return grp-return--none mono ${className}`}>—</span>;
  }
  const dir = ratio > 0.0005 ? "up" : ratio < -0.0005 ? "down" : "flat";
  const tone = dir === "up" ? "text-bull" : dir === "down" ? "text-bear" : "text-muted";
  return (
    <span className={`grp-return mono ${tone} ${className}`} data-dir={dir}>
      {formatPct(ratio)}
    </span>
  );
}

/** Monospaced USD price, or a muted placeholder when unpriced. */
export function Money({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  if (value == null || !Number.isFinite(value)) {
    return <span className={`mono text-faint ${className}`}>—</span>;
  }
  return <span className={`mono ${className}`}>{formatPrice(value)}</span>;
}

/**
 * Inline confirmation that a typed ticker resolves to a real listed security
 * (via the bundled symbol directory). Surfaces the company name + exchange so a
 * member knows exactly what they're adding before they commit.
 */
export function SymbolHint({ query }: { query: string }) {
  const match = useMemo(() => resolveSymbol(query), [query]);
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (!match) {
    return (
      <span className="grp-symhint grp-symhint--miss">No match for “{trimmed}” — check the ticker.</span>
    );
  }
  return (
    <span className="grp-symhint grp-symhint--hit">
      <span className="ticker mono">{match.symbol}</span>
      <span className="grp-symhint__name">{match.name}</span>
      <span className="grp-symhint__exch mono">{match.exchange}</span>
    </span>
  );
}

export { formatPrice, formatPct };
