import { useEffect, useState } from "react";
import { useGroupsStore } from "@/store/useGroupsStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useAppStore } from "@/store/useAppStore";
import { Modal } from "@/components/common/Modal";
import { IconRefresh, IconWatchlist } from "@/components/icons";
import { IconBell, IconChat, IconLink, IconPoll } from "./icons";
import { GroupAvatar, MemberStack, RoleBadge } from "./shared";
import { MemberHoldings } from "./MemberHoldings";
import { SharedWatchlist } from "./SharedWatchlist";
import { CallLedger } from "./CallLedger";
import { CallLeaderboard } from "./CallLeaderboard";
import { GroupChat } from "./GroupChat";
import { GroupPolls } from "./GroupPolls";
import { GroupActivity } from "./GroupActivity";
import { InviteModal } from "./InviteModal";
import { InviteFriendsModal } from "./InviteFriendsModal";
import { IconFriends } from "@/components/icons";
import type { GroupMember, GroupSummary } from "@/data/groups/types";

type GroupTab = "markets" | "chat" | "polls" | "activity";

const MEMBER_ROLE_LABEL: Record<GroupMember["role"], string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function DetailSkeleton() {
  return (
    <div className="grp-detail" aria-busy="true">
      <div className="grp-detail__hero">
        <span className="skeleton grp-skel grp-skel--title" />
        <span className="skeleton grp-skel grp-skel--sub" />
      </div>
      <div className="grp-grid">
        <div className="grp-grid__main">
          <span className="skeleton grp-skel grp-skel--panel" />
          <span className="skeleton grp-skel grp-skel--panel" />
        </div>
        <span className="skeleton grp-skel grp-skel--panel" />
      </div>
    </div>
  );
}

export function GroupDetail({ summary }: { summary: GroupSummary }) {
  const members = useGroupsStore((s) => s.members);
  const invite = useGroupsStore((s) => s.invite);
  const detailStatus = useGroupsStore((s) => s.detailStatus);
  const detailError = useGroupsStore((s) => s.detailError);
  const refreshActive = useGroupsStore((s) => s.refreshActive);
  const leaveActive = useGroupsStore((s) => s.leaveActive);
  const setLeaderboard = useGroupsStore((s) => s.setLeaderboard);
  const unreadFor = useGroupsStore((s) => s.unreadFor);
  const markRead = useGroupsStore((s) => s.markRead);
  const activity = useGroupsStore((s) => s.activity);
  const readMarks = useGroupsStore((s) => s.readMarks);
  const pushToast = useAppStore((s) => s.pushToast);
  const viewerId = useAuthStore((s) => s.userId);

  const [showInvite, setShowInvite] = useState(false);
  const [showInviteFriends, setShowInviteFriends] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [prefillCall, setPrefillCall] = useState<string | null>(null);
  const [holdingsMember, setHoldingsMember] = useState<GroupMember | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [tab, setTab] = useState<GroupTab>("markets");

  const isAdmin = summary.role === "owner" || summary.role === "admin";
  // Recompute unread when the feed or read mark changes (selectors above force it).
  const unread = unreadFor(summary.id);
  void activity;
  void readMarks;

  // Opening the Activity tab clears the unread badge.
  useEffect(() => {
    if (tab === "activity") void markRead(summary.id);
  }, [tab, summary.id, markRead, activity.length]);

  // Reset to the Markets tab when switching groups.
  useEffect(() => {
    setTab("markets");
  }, [summary.id]);

  if (detailStatus === "loading" && members.length === 0) return <DetailSkeleton />;

  if (detailStatus === "error") {
    return (
      <div className="empty grp-empty grp-detail__error" role="alert">
        <h3>Couldn't load this group</h3>
        <p>{detailError}</p>
        <button className="btn btn--ghost btn--sm" onClick={() => void refreshActive()}>
          <IconRefresh size={14} /> Try again
        </button>
      </div>
    );
  }

  const doLeave = async () => {
    const r = await leaveActive();
    if (r.ok) pushToast(`You left ${summary.name}.`, "success");
    else pushToast(r.error ?? "Couldn't leave the group.", "warn");
  };

  return (
    <div className="grp-detail">
      <header className="grp-detail__hero">
        <div className="grp-detail__heroglow" aria-hidden="true" />
        <div className="grp-detail__heromain">
          <div className="grp-detail__titlerow">
            <h2 className="grp-detail__name">{summary.name}</h2>
            <RoleBadge role={summary.role} />
          </div>
          {summary.description && <p className="grp-detail__desc">{summary.description}</p>}
          <div className="grp-detail__metarow">
            <MemberStack
              members={members}
              viewerId={viewerId}
              onViewHoldings={setHoldingsMember}
            />
            <span className="grp-detail__count text-muted">
              {summary.memberCount} member{summary.memberCount === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="grp-detail__members-btn"
              onClick={() => setShowMembers(true)}
            >
              View all members
            </button>
          </div>
        </div>

        <div className="grp-detail__actions">
          <button className="btn btn--primary btn--sm" onClick={() => setShowInviteFriends(true)}>
            <IconFriends size={14} /> Invite friends
          </button>
          {invite && (
            <button className="btn btn--ghost btn--sm" onClick={() => setShowInvite(true)}>
              <IconLink size={14} /> Invite link
            </button>
          )}
          {isAdmin && (
            <label className="grp-switch" title="Rank members by their calls' performance">
              <input
                type="checkbox"
                checked={summary.leaderboardEnabled}
                onChange={(e) => void setLeaderboard(e.target.checked)}
              />
              <span className="grp-switch__track" aria-hidden="true">
                <span className="grp-switch__thumb" />
              </span>
              <span className="grp-switch__label">Leaderboard</span>
            </label>
          )}
          {confirmLeave ? (
            <span className="grp-leave">
              <button className="btn btn--ghost btn--sm grp-leave__yes" onClick={() => void doLeave()}>
                Confirm leave
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirmLeave(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="grp-textbtn" onClick={() => setConfirmLeave(true)}>
              Leave
            </button>
          )}
        </div>
      </header>

      <nav className="grp-tabs" role="tablist" aria-label="Group sections">
        {([
          { id: "markets", label: "Markets", icon: <IconWatchlist size={15} /> },
          { id: "chat", label: "Chat", icon: <IconChat size={15} /> },
          { id: "polls", label: "Polls", icon: <IconPoll size={15} /> },
          { id: "activity", label: "Activity", icon: <IconBell size={15} /> },
        ] as const).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`grp-tab ${tab === t.id ? "grp-tab--active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
            {t.id === "activity" && unread > 0 && tab !== "activity" && (
              <span className="grp-tab__badge mono" aria-label={`${unread} unread`}>
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        ))}
      </nav>

      {tab === "markets" ? (
        <div className="grp-grid">
          <div className="grp-grid__main">
            <SharedWatchlist currentUserId={viewerId} isAdmin={isAdmin} onCall={setPrefillCall} />
            <CallLedger
              currentUserId={viewerId}
              isAdmin={isAdmin}
              prefillTicker={prefillCall}
              onPrefillConsumed={() => setPrefillCall(null)}
            />
          </div>
          <aside className="grp-grid__aside">
            <CallLeaderboard leaderboardEnabled={summary.leaderboardEnabled} isAdmin={isAdmin} />
          </aside>
        </div>
      ) : tab === "chat" ? (
        <GroupChat currentUserId={viewerId} isAdmin={isAdmin} />
      ) : tab === "polls" ? (
        <GroupPolls currentUserId={viewerId} isAdmin={isAdmin} />
      ) : (
        <GroupActivity groupId={summary.id} />
      )}

      {showInvite && invite && (
        <InviteModal token={invite.token} groupName={summary.name} onClose={() => setShowInvite(false)} />
      )}

      {showInviteFriends && (
        <InviteFriendsModal
          groupId={summary.id}
          groupName={summary.name}
          members={members}
          onClose={() => setShowInviteFriends(false)}
        />
      )}

      {showMembers && (
        <Modal
          title={`${summary.name} members`}
          onClose={() => setShowMembers(false)}
          className="grp-members-modal"
        >
          <div className="grp-members-roster" role="list">
            {members.map((member) => {
              const label = member.profile.displayName || member.profile.handle || "Member";
              return (
                <div key={member.membershipId} className="grp-member-row" role="listitem">
                  <GroupAvatar profile={member.profile} size={38} />
                  <div className="grp-member-row__identity">
                    <span className="grp-member-row__name">{label}</span>
                    {member.profile.handle && (
                      <span className="grp-member-row__handle mono">@{member.profile.handle}</span>
                    )}
                  </div>
                  <span className={`grp-role grp-role--${member.role}`}>
                    {MEMBER_ROLE_LABEL[member.role]}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm grp-member-row__action"
                    onClick={() => {
                      setShowMembers(false);
                      setHoldingsMember(member);
                    }}
                  >
                    View holdings
                  </button>
                </div>
              );
            })}
          </div>
        </Modal>
      )}

      {holdingsMember && (
        <MemberHoldings
          member={holdingsMember}
          groupId={summary.id}
          onClose={() => setHoldingsMember(null)}
        />
      )}
    </div>
  );
}
