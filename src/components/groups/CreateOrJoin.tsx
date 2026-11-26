import { useEffect, useState } from "react";
import { useGroupsStore } from "@/store/useGroupsStore";
import { useAppStore } from "@/store/useAppStore";
import { IconPlus, IconCheck } from "@/components/icons";
import { IconLink } from "./icons";
import { tokenFromInvite } from "./invite";
import type { InvitePreview } from "@/data/groups/types";

type Mode = "create" | "join";

/**
 * The on-ramp into Groups: create a new private space or join one from an invite
 * link/code. Used in the empty-state hero and from the "New group" affordance.
 */
export function CreateOrJoin({
  defaultMode = "create",
  prefillToken = "",
  onDone,
}: {
  defaultMode?: Mode;
  prefillToken?: string;
  onDone?: (groupId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>(prefillToken ? "join" : defaultMode);
  return (
    <div className="grp-onboard card">
      <div className="segmented grp-onboard__tabs" role="tablist" aria-label="Create or join a group">
        <button role="tab" aria-selected={mode === "create"} className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>
          Create
        </button>
        <button role="tab" aria-selected={mode === "join"} className={mode === "join" ? "active" : ""} onClick={() => setMode("join")}>
          Join
        </button>
      </div>
      {mode === "create" ? <CreateForm onDone={onDone} /> : <JoinForm prefillToken={prefillToken} onDone={onDone} />}
    </div>
  );
}

function CreateForm({ onDone }: { onDone?: (groupId: string) => void }) {
  const createGroup = useGroupsStore((s) => s.createGroup);
  const pushToast = useAppStore((s) => s.pushToast);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const r = await createGroup(name, description);
    setBusy(false);
    if (r.ok && r.groupId) {
      pushToast(`Created “${name.trim()}” — share the invite link to bring your group in.`, "success");
      onDone?.(r.groupId);
    } else {
      setErr(r.error ?? "Couldn't create the group.");
    }
  };

  return (
    <div className="grp-form">
      <p className="grp-form__lede text-muted">
        A private space for you and your circle — a shared watchlist and a call leaderboard, invite-only.
      </p>
      <div className="field">
        <label htmlFor="grp-name">Group name</label>
        <input
          id="grp-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="e.g. The Finance Group Chat"
          maxLength={80}
        />
      </div>
      <div className="field">
        <label htmlFor="grp-desc">Description <span className="text-faint">(optional)</span></label>
        <input
          id="grp-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="What's this group about?"
          maxLength={160}
        />
      </div>
      {err && <p className="grp-form__error" role="alert">{err}</p>}
      <button className="btn btn--primary grp-form__submit" onClick={() => void submit()} disabled={busy || !name.trim()}>
        <IconPlus size={15} /> {busy ? "Creating…" : "Create group"}
      </button>
    </div>
  );
}

function JoinForm({ prefillToken, onDone }: { prefillToken?: string; onDone?: (groupId: string) => void }) {
  const joinByToken = useGroupsStore((s) => s.joinByToken);
  const peek = useGroupsStore((s) => s.peek);
  const pushToast = useAppStore((s) => s.pushToast);
  const [value, setValue] = useState(prefillToken ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitePreview | null>(null);

  // Live-preview the group behind a pasted link so the user knows what they join.
  useEffect(() => {
    const token = tokenFromInvite(value);
    if (!token) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void peek(token).then((p) => {
        if (live) setPreview(p);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value, peek]);

  const submit = async () => {
    const token = tokenFromInvite(value);
    if (!token || busy) {
      setErr("Paste a full invite link or code.");
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await joinByToken(token);
    setBusy(false);
    if (r.ok && r.groupId) {
      pushToast(`Joined ${r.groupName ?? "the group"}.`, "success");
      onDone?.(r.groupId);
    } else {
      setErr(r.error ?? "Couldn't join.");
    }
  };

  return (
    <div className="grp-form">
      <p className="grp-form__lede text-muted">
        Got an invite link from your group? Paste it here to join. One link onboards everyone.
      </p>
      <div className="field">
        <label htmlFor="grp-token">Invite link or code</label>
        <input
          id="grp-token"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Paste invite link…"
        />
      </div>
      {preview && preview.valid && preview.groupName && (
        <div className="grp-join-preview">
          <IconCheck size={15} />
          <span>
            Joining <strong>{preview.groupName}</strong>{" "}
            <span className="text-faint">· {preview.memberCount} member{preview.memberCount === 1 ? "" : "s"}</span>
          </span>
        </div>
      )}
      {preview && !preview.valid && tokenFromInvite(value) && (
        <p className="grp-form__error" role="alert">That invite link isn't valid anymore.</p>
      )}
      {err && <p className="grp-form__error" role="alert">{err}</p>}
      <button className="btn btn--primary grp-form__submit" onClick={() => void submit()} disabled={busy || !tokenFromInvite(value)}>
        <IconLink size={15} /> {busy ? "Joining…" : "Join group"}
      </button>
    </div>
  );
}
