import { useMemo, useState } from "react";
import { Modal } from "@/components/common/Modal";
import { useAuthStore } from "@/store/useAuthStore";
import { useGroupsStore } from "@/store/useGroupsStore";
import { useAppStore } from "@/store/useAppStore";
import { IconSearch, IconCheck } from "@/components/icons";
import { IconGroups } from "./icons";
import { GroupAvatar } from "./shared";
import type { GroupMember } from "@/data/groups/types";
import type { Profile } from "@/data/supabase/friends";

/**
 * Friend-picker for inviting people directly into a group (alongside the
 * link/code path). Lists the viewer's friends who AREN'T already members; one
 * tap sends each an in-app notification + a pending invite they accept from
 * their Groups tab. Mirrors the friends-list / member-popover visual language.
 */
export function InviteFriendsModal({
  groupId,
  groupName,
  members,
  onClose,
}: {
  groupId: string;
  groupName: string;
  members: GroupMember[];
  onClose: () => void;
}) {
  const friends = useAuthStore((s) => s.friends);
  const inviteFriendToGroup = useGroupsStore((s) => s.inviteFriendToGroup);
  const pushToast = useAppStore((s) => s.pushToast);

  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  /** Friend ids we've successfully invited this session → show an "Invited" state. */
  const [invited, setInvited] = useState<Set<string>>(new Set());

  // Friends who aren't already in the group (members can't be invited again).
  const memberIds = useMemo(() => new Set(members.map((m) => m.profile.id)), [members]);
  const invitable = useMemo(
    () => friends.map((f) => f.profile).filter((p) => !memberIds.has(p.id)),
    [friends, memberIds],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@+/, "");
    if (!q) return invitable;
    return invitable.filter(
      (p) =>
        (p.displayName ?? "").toLowerCase().includes(q) ||
        (p.handle ?? "").toLowerCase().includes(q),
    );
  }, [invitable, query]);

  const invite = async (p: Profile) => {
    setPending(p.id);
    const r = await inviteFriendToGroup(groupId, p.id);
    setPending(null);
    if (r.ok) {
      setInvited((prev) => new Set(prev).add(p.id));
      pushToast(`Invited ${p.displayName || (p.handle ? `@${p.handle}` : "your friend")} to ${groupName}`, "success");
    } else {
      // "Already in" / "already invited" are soft outcomes - mark them done too.
      if (r.alreadyMember || /already/i.test(r.error ?? "")) {
        setInvited((prev) => new Set(prev).add(p.id));
      }
      pushToast(r.error ?? "Couldn't send the invite.", "warn");
    }
  };

  const hasFriends = friends.length > 0;

  return (
    <Modal title={`Invite friends to ${groupName}`} onClose={onClose} className="grp-invitef-modal">
      <p className="text-muted grp-invite__lede">
        Pick a friend to invite straight into the group — they'll get a notification and can accept
        from their Groups tab. The invite link still works too.
      </p>

      {!hasFriends ? (
        <div className="empty grp-invitef__empty">
          <IconGroups size={24} />
          <p>Add some friends first, then you can invite them to your groups.</p>
        </div>
      ) : invitable.length === 0 ? (
        <div className="empty grp-invitef__empty">
          <IconCheck size={22} />
          <p>All your friends are already in {groupName}. Share the invite link to bring in more.</p>
        </div>
      ) : (
        <>
          <div className="grp-invitef__search">
            <IconSearch size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search friends…"
              aria-label="Search friends"
              autoFocus
            />
          </div>

          {filtered.length === 0 ? (
            <p className="text-faint grp-invitef__noresult">No friends match “{query.trim()}”.</p>
          ) : (
            <ul className="grp-invitef__list" role="list">
              {filtered.map((p) => {
                const label = p.displayName || p.handle || "Friend";
                const done = invited.has(p.id);
                const busy = pending === p.id;
                return (
                  <li key={p.id} className="grp-invitef__row">
                    <GroupAvatar profile={p} size={36} />
                    <span className="grp-invitef__who">
                      <span className="grp-invitef__name">{label}</span>
                      {p.handle && <span className="grp-invitef__handle">@{p.handle}</span>}
                    </span>
                    {done ? (
                      <span className="grp-invitef__done">
                        <IconCheck size={14} /> Invited
                      </span>
                    ) : (
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => void invite(p)}
                        disabled={busy}
                      >
                        {busy ? "Inviting…" : "Invite"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
