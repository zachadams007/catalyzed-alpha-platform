import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { StockSignal } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useGroupsStore } from "@/store/useGroupsStore";
import { APP_NAME } from "@/lib/app";
import { Modal } from "@/components/common/Modal";
import { SignInModal } from "@/components/auth/SignInModal";
import { avatarAccentFromLabel, initialsFromLabel } from "@/lib/profileDisplay";
import { IconCheck, IconCopy, IconFriends, IconLayers, IconShare } from "@/components/icons";

/** Synthetic id for the "all friends" broadcast target (vs. real group ids). */
const FRIENDS_TARGET = "friends";

interface Props {
  signal: StockSignal;
  onClose: () => void;
}

interface SendResult {
  label: string;
  ok: boolean;
  error?: string;
}

/** "a, b, and c" - for a human-readable confirmation summary. */
function humanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** One selectable destination (a friend group or the friends broadcast). */
function TargetRow({
  avatar,
  accent,
  name,
  sub,
  selected,
  disabled,
  onClick,
}: {
  avatar: ReactNode;
  accent: string;
  name: string;
  sub: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`share-target${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="avatar share-target__avatar" style={{ background: accent }}>
        {avatar}
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

export function ShareSignalModal({ signal, onClose }: Props) {
  const navigate = useNavigate();

  const configured = useAuthStore((s) => s.configured);
  const userId = useAuthStore((s) => s.userId);
  const friends = useAuthStore((s) => s.friends);
  const shareTicker = useAuthStore((s) => s.shareTicker);

  const groups = useGroupsStore((s) => s.groups);
  const groupsStatus = useGroupsStore((s) => s.groupsStatus);
  const loadMyGroups = useGroupsStore((s) => s.loadMyGroups);
  const shareTickerToGroup = useGroupsStore((s) => s.shareTickerToGroup);

  const pushToast = useAppStore((s) => s.pushToast);

  const signedIn = configured && !!userId;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState((signal.thesis ?? "").trim());
  const [phase, setPhase] = useState<"compose" | "sending" | "done">("compose");
  const [results, setResults] = useState<SendResult[]>([]);
  const [showSignIn, setShowSignIn] = useState(false);

  // Freshen the viewer's groups + friends when the share sheet opens.
  useEffect(() => {
    if (!signedIn) return;
    void loadMyGroups();
    void useAuthStore.getState().refresh();
  }, [signedIn, loadMyGroups]);

  // On a clean, fully successful send, dismiss after a short confirmation beat.
  useEffect(() => {
    if (phase !== "done" || results.length === 0 || !results.every((r) => r.ok)) return;
    const t = window.setTimeout(onClose, 1300);
    return () => window.clearTimeout(t);
  }, [phase, results, onClose]);

  const shareText = `${signal.ticker} — ${signal.name} · Opportunity ${signal.score.opportunityScore}/100 (${APP_NAME})`;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const copy = () => {
    const trimmed = note.trim();
    const payload = trimmed ? `${shareText}\n“${trimmed}”` : shareText;
    void navigator.clipboard?.writeText(payload).catch(() => undefined);
    useAppStore.getState().recordInteraction("share", signal);
    pushToast(`Copied ${signal.ticker} to clipboard`, "success");
  };

  const send = async () => {
    if (selected.size === 0 || phase === "sending") return;
    setPhase("sending");
    const out: SendResult[] = [];

    if (selected.has(FRIENDS_TARGET)) {
      const r = await shareTicker(signal.ticker, note);
      out.push({ label: "your friends", ok: r.ok, error: r.error });
    }
    for (const g of groups) {
      if (!selected.has(g.id)) continue;
      const r = await shareTickerToGroup(g.id, signal.ticker, note);
      out.push({ label: g.name, ok: r.ok, error: r.error });
    }

    const okLabels = out.filter((r) => r.ok).map((r) => r.label);
    if (okLabels.length > 0) useAppStore.getState().recordInteraction("share", signal);

    setResults(out);
    setPhase("done");

    if (okLabels.length === out.length) {
      pushToast(`Shared ${signal.ticker} with ${humanList(okLabels)}`, "success");
    } else if (okLabels.length > 0) {
      pushToast(`Shared ${signal.ticker} with ${okLabels.length} of ${out.length} — some failed`, "warn");
    } else {
      pushToast(out[0]?.error ?? `Couldn't share ${signal.ticker}`, "warn");
    }
  };

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  const preview = (
    <div className="share-preview">
      <span className="ticker mono share-preview__ticker">{signal.ticker}</span>
      <span className="share-preview__name">{signal.name}</span>
      <span className="share-preview__score mono">{signal.score.opportunityScore}</span>
    </div>
  );

  // ---- Body: not-configured / signed-out / compose / done -------------------
  let body: ReactNode;

  if (phase === "done") {
    const allOk = results.every((r) => r.ok);
    body = (
      <div className="share-done">
        <div className={`share-done__mark${allOk ? "" : " is-partial"}`}>
          <IconCheck size={26} />
        </div>
        <p className="share-done__title">
          {allOk ? "Shared" : "Partly shared"} {signal.ticker}
        </p>
        <ul className="share-done__list">
          {results.map((r) => (
            <li key={r.label} className={r.ok ? "is-ok" : "is-fail"}>
              <span>{r.ok ? "Sent to" : "Couldn't reach"} {r.label}</span>
              {!r.ok && r.error ? <span className="share-done__err text-faint">{r.error}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (!configured) {
    body = (
      <>
        {preview}
        <div className="empty share-empty">
          <IconFriends size={26} />
          <h3>Social sharing isn’t set up</h3>
          <p>
            Sharing to friends and groups needs the social backend. You can still copy this
            signal and paste it anywhere.
          </p>
        </div>
      </>
    );
  } else if (!signedIn) {
    body = (
      <>
        {preview}
        <div className="empty share-empty">
          <IconFriends size={26} />
          <h3>Sign in to share</h3>
          <p>Send {signal.ticker} straight to your friends or a private group.</p>
          <button className="btn btn--primary btn--sm" onClick={() => setShowSignIn(true)}>
            Sign in
          </button>
        </div>
      </>
    );
  } else {
    const noFriends = friends.length === 0;
    body = (
      <>
        {preview}

        <div className="field share-note">
          <label htmlFor="share-note">Add a note <span className="text-faint">(optional)</span></label>
          <textarea
            id="share-note"
            rows={2}
            value={note}
            maxLength={280}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why it’s interesting…"
          />
        </div>

        <div className="act-group-label share-section-label">Send to</div>

        <div className="share-targets">
          <TargetRow
            avatar={<IconFriends size={18} />}
            accent="var(--accent)"
            name="Your friends"
            sub={
              noFriends
                ? "No friends yet — add some on the Friends tab"
                : `${friends.length} ${friends.length === 1 ? "friend" : "friends"}`
            }
            selected={selected.has(FRIENDS_TARGET)}
            disabled={noFriends}
            onClick={() => toggle(FRIENDS_TARGET)}
          />

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
              <TargetRow
                key={g.id}
                avatar={initialsFromLabel(g.name)}
                accent={avatarAccentFromLabel(g.name)}
                name={g.name}
                sub={`${g.memberCount} ${g.memberCount === 1 ? "member" : "members"}`}
                selected={selected.has(g.id)}
                onClick={() => toggle(g.id)}
              />
            ))
          )}
        </div>

        {groupsStatus !== "loading" && groups.length === 0 && (
          <button type="button" className="share-link" onClick={() => go("/groups")}>
            <IconLayers size={14} /> Create a group to share with
          </button>
        )}
        {noFriends && (
          <button type="button" className="share-link" onClick={() => go("/friends")}>
            <IconFriends size={14} /> Find friends to share with
          </button>
        )}
      </>
    );
  }

  // ---- Footer ---------------------------------------------------------------
  let footer: ReactNode;
  if (phase === "done") {
    footer = (
      <button className="btn btn--ghost" onClick={onClose}>
        Done
      </button>
    );
  } else {
    footer = (
      <>
        <button className="btn btn--ghost" onClick={copy}>
          <IconCopy size={15} /> Copy
        </button>
        {signedIn && (
          <button
            className="btn btn--primary"
            onClick={() => void send()}
            disabled={selected.size === 0 || phase === "sending"}
            style={{ "--share-count": selected.size } as CSSProperties}
          >
            <IconShare size={15} />{" "}
            {phase === "sending" ? "Sharing…" : selected.size > 0 ? `Share (${selected.size})` : "Share"}
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <Modal
        title={phase === "done" ? "" : `Share ${signal.ticker}`}
        onClose={onClose}
        className="share-modal"
        footer={footer}
      >
        {body}
      </Modal>
      {showSignIn && <SignInModal onClose={() => setShowSignIn(false)} />}
    </>
  );
}
