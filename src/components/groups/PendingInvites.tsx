import { useState } from "react";
import { useGroupsStore } from "@/store/useGroupsStore";
import { useAppStore } from "@/store/useAppStore";
import { IconCheck, IconClose } from "@/components/icons";
import { IconGroups } from "./icons";
import { GroupAvatar } from "./shared";
import type { PendingGroupInvite } from "@/data/groups/types";

/**
 * Incoming friend → group invites for the viewer, shown at the top of the Groups
 * tab. One tap to Accept (joins + opens the group) or Decline. Loaded + kept live
 * by the groups store's auth lifecycle (subscribeToMyGroupInvites). Renders
 * nothing when there are no pending invites so it never clutters the empty page.
 */
export function PendingInvites() {
  const pendingInvites = useGroupsStore((s) => s.pendingInvites);
  const invitesStatus = useGroupsStore((s) => s.invitesStatus);

  // Quiet until there's something to act on (loading/empty/error all collapse to
  // null - the section is purely additive and must never block the page).
  if (pendingInvites.length === 0) {
    if (invitesStatus === "loading" && pendingInvites.length === 0) {
      // Brief skeleton only while we genuinely don't know yet AND nothing's shown.
      return null;
    }
    return null;
  }

  return (
    <section className="grp-pending" aria-label="Pending group invites">
      <header className="grp-pending__head">
        <span className="grp-pending__icon"><IconGroups size={16} /></span>
        <h3 className="grp-pending__title">
          Group invite{pendingInvites.length === 1 ? "" : "s"}
        </h3>
        <span className="grp-pending__count mono">{pendingInvites.length}</span>
      </header>
      <ul className="grp-pending__list" role="list">
        {pendingInvites.map((invite) => (
          <PendingInviteRow key={invite.id} invite={invite} />
        ))}
      </ul>
    </section>
  );
}

function PendingInviteRow({ invite }: { invite: PendingGroupInvite }) {
  const acceptInvite = useGroupsStore((s) => s.acceptInvite);
  const declineInvite = useGroupsStore((s) => s.declineInvite);
  const pushToast = useAppStore((s) => s.pushToast);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);

  const inviterLabel =
    invite.inviter.displayName || (invite.inviter.handle ? `@${invite.inviter.handle}` : "A friend");

  const accept = async () => {
    setBusy("accept");
    const r = await acceptInvite(invite.id);
    // The row is removed optimistically by the store; only surface failures.
    if (!r.ok) {
      setBusy(null);
      pushToast(r.error ?? "Couldn't join the group.", "warn");
    } else {
      pushToast(`Joined ${r.groupName ?? invite.groupName}.`, "success");
    }
  };

  const decline = async () => {
    setBusy("decline");
    await declineInvite(invite.id);
  };

  return (
    <li className="grp-pending__row">
      <GroupAvatar profile={invite.inviter} size={38} />
      <div className="grp-pending__copy">
        <span className="grp-pending__line">
          <strong>{inviterLabel}</strong> invited you to <strong>{invite.groupName}</strong>
        </span>
      </div>
      <div className="grp-pending__actions">
        <button
          className="btn btn--primary btn--sm"
          onClick={() => void accept()}
          disabled={busy !== null}
        >
          <IconCheck size={14} /> {busy === "accept" ? "Joining…" : "Accept"}
        </button>
        <button
          className="grp-pending__decline"
          onClick={() => void decline()}
          disabled={busy !== null}
          aria-label={`Decline invite to ${invite.groupName}`}
          title="Decline"
        >
          <IconClose size={15} />
        </button>
      </div>
    </li>
  );
}
