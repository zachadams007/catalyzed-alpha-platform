import { useState } from "react";
import { useGroupsStore } from "@/store/useGroupsStore";
import { Modal } from "@/components/common/Modal";
import { IconPlus } from "@/components/icons";
import { IconGroups, IconTrophy } from "./icons";
import { CreateOrJoin } from "./CreateOrJoin";

/** Horizontal rail of the user's groups + the "new group" on-ramp. */
export function MyGroupsRail() {
  const groups = useGroupsStore((s) => s.groups);
  const activeId = useGroupsStore((s) => s.activeId);
  const selectGroup = useGroupsStore((s) => s.selectGroup);
  const unreadFor = useGroupsStore((s) => s.unreadFor);
  // Subscribe to the stamps/marks so the dots re-render as they change.
  useGroupsStore((s) => s.latestActivity);
  useGroupsStore((s) => s.readMarks);
  const [showNew, setShowNew] = useState(false);

  return (
    <div className="grp-rail">
      <div className="grp-rail__scroll" role="tablist" aria-label="Your groups">
        {groups.map((g) => {
          const hasUnread = unreadFor(g.id) > 0;
          return (
          <button
            key={g.id}
            role="tab"
            aria-selected={g.id === activeId}
            className={`grp-card ${g.id === activeId ? "grp-card--active" : ""}`}
            onClick={() => void selectGroup(g.id)}
          >
            <span className="grp-card__mark" aria-hidden="true">
              <IconGroups size={16} />
              {hasUnread && <span className="grp-card__unread" title="New activity" />}
            </span>
            <span className="grp-card__body">
              <span className="grp-card__name">{g.name}</span>
              <span className="grp-card__meta">
                {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
                {g.leaderboardEnabled && (
                  <span className="grp-card__lb" title="Leaderboard on">
                    <IconTrophy size={11} />
                  </span>
                )}
              </span>
            </span>
          </button>
          );
        })}
        <button className="grp-card grp-card--new" onClick={() => setShowNew(true)}>
          <span className="grp-card__mark grp-card__mark--new" aria-hidden="true">
            <IconPlus size={16} />
          </span>
          <span className="grp-card__body">
            <span className="grp-card__name">New group</span>
            <span className="grp-card__meta">Create or join</span>
          </span>
        </button>
      </div>

      {showNew && (
        <Modal title="New group" onClose={() => setShowNew(false)} className="grp-new-modal">
          <CreateOrJoin onDone={() => setShowNew(false)} />
        </Modal>
      )}
    </div>
  );
}
