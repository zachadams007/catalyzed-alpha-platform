import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { StockSignal } from "@/types";
import type { CallDirection } from "@/data/groups/types";
import { useAppStore } from "@/store/useAppStore";
import { useGroupsStore } from "@/store/useGroupsStore";
import { Modal } from "@/components/common/Modal";
import { avatarAccentFromLabel, initialsFromLabel } from "@/lib/profileDisplay";
import { IconCheck, IconLayers, IconMega } from "@/components/icons";

interface Props {
  signal: StockSignal;
  onClose: () => void;
}

/** One selectable target group (single-select, unlike the Share sheet's multi-select). */
function GroupRow({
  name,
  sub,
  selected,
  onClick,
}: {
  name: string;
  sub: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`share-target${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="avatar share-target__avatar" style={{ background: avatarAccentFromLabel(name) }}>
        {initialsFromLabel(name)}
      </span>
      <span className="share-target__text">
        <span className="share-target__name">{name}</span>
        <span className="share-target__sub text-faint">{sub}</span>
      </span>
      <span className="share-target__check" aria-hidden="true">
        {selected ? <IconCheck size={15} /> : null}
      </span>
    </button>
  );
}

/** Call out a stock (a ranked buy/watch call for the Call Leaderboard) to one of the viewer's groups. */
export function CalloutToGroupModal({ signal, onClose }: Props) {
  const navigate = useNavigate();

  const groups = useGroupsStore((s) => s.groups);
  const groupsStatus = useGroupsStore((s) => s.groupsStatus);
  const loadMyGroups = useGroupsStore((s) => s.loadMyGroups);
  const logCall = useGroupsStore((s) => s.logCall);

  const pushToast = useAppStore((s) => s.pushToast);

  const [groupId, setGroupId] = useState<string | null>(null);
  const [direction, setDirection] = useState<CallDirection>("buy");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Freshen the viewer's groups when the sheet opens.
  useEffect(() => {
    void loadMyGroups();
  }, [loadMyGroups]);

  // Default the selection to the first (often only) group once groups load.
  useEffect(() => {
    if (groupId || groups.length === 0) return;
    setGroupId(groups[0].id);
  }, [groups, groupId]);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  const submit = async () => {
    if (!groupId || busy) return;
    setBusy(true);
    setErr(null);
    const r = await logCall(signal.ticker, direction, note, groupId);
    setBusy(false);
    if (r.ok) {
      const groupName = groups.find((g) => g.id === groupId)?.name ?? "your group";
      pushToast(`Called out ${signal.ticker} to ${groupName}`, "success");
      onClose();
    } else {
      setErr(r.error ?? `Couldn't call out ${signal.ticker}.`);
    }
  };

  const preview = (
    <div className="share-preview">
      <span className="ticker mono share-preview__ticker">{signal.ticker}</span>
      <span className="share-preview__name">{signal.name}</span>
      <span className="share-preview__score mono">{signal.score.opportunityScore}</span>
    </div>
  );

  let body: ReactNode;

  if (groupsStatus !== "loading" && groups.length === 0) {
    body = (
      <>
        {preview}
        <div className="empty share-empty">
          <IconMega size={26} />
          <h3>No groups yet</h3>
          <p>Join or create a group to call out {signal.ticker} — calls rank on that group's leaderboard.</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => go("/groups")}>
            <IconLayers size={14} /> Go to Groups
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        {preview}

        <div className="act-group-label share-section-label">Call to</div>

        <div className="share-targets">
          {groupsStatus === "loading" && groups.length === 0 ? (
            <>
              <div className="share-target share-target--skeleton">
                <span className="skeleton share-target__avatar" />
                <span className="skeleton share-target__skel-line" />
              </div>
              <div className="share-target share-target--skeleton">
                <span className="skeleton share-target__avatar" />
                <span className="skeleton share-target__skel-line" />
              </div>
            </>
          ) : (
            groups.map((g) => (
              <GroupRow
                key={g.id}
                name={g.name}
                sub={`${g.memberCount} ${g.memberCount === 1 ? "member" : "members"}`}
                selected={groupId === g.id}
                onClick={() => setGroupId(g.id)}
              />
            ))
          )}
        </div>

        <div className="segmented" role="group" aria-label="Call direction">
          <button
            type="button"
            className={direction === "buy" ? "active" : ""}
            onClick={() => setDirection("buy")}
          >
            Buy
          </button>
          <button
            type="button"
            className={direction === "watch" ? "active" : ""}
            onClick={() => setDirection("watch")}
          >
            Watch
          </button>
        </div>

        <div className="field share-note">
          <label htmlFor="callout-note">Add a note <span className="text-faint">(optional)</span></label>
          <textarea
            id="callout-note"
            rows={2}
            value={note}
            maxLength={280}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Why ${signal.ticker} is a ${direction}…`}
          />
        </div>

        {err && <p className="grp-form__error" role="alert">{err}</p>}
      </>
    );
  }

  const footer =
    groups.length === 0 ? (
      <button className="btn btn--ghost" onClick={onClose}>
        Close
      </button>
    ) : (
      <>
        <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void submit()}
          disabled={!groupId || busy}
        >
          <IconMega size={15} /> {busy ? "Calling out…" : "Call out"}
        </button>
      </>
    );

  return (
    <Modal title={`Call out ${signal.ticker}`} onClose={onClose} className="share-modal" footer={footer}>
      {body}
    </Modal>
  );
}
