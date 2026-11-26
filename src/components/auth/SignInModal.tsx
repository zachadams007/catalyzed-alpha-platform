import { useId, useMemo, useState } from "react";
import { Modal } from "@/components/common/Modal";
import { useAuthStore } from "@/store/useAuthStore";
import { avatarAccentFromLabel, initialsFromLabel } from "@/lib/profileDisplay";

type Mode = "signin" | "signup";

/**
 * Email + password sign-in. New users also set a display name (avatar initials)
 * and a handle (what friends search for). No email OTP codes.
 */
export function SignInModal({
  onClose,
  defaultMode = "signin",
}: {
  onClose: () => void;
  /** Start on "New account" when we know the visitor is likely new (e.g. arriving via an invite link). */
  defaultMode?: Mode;
}) {
  const signUp = useAuthStore((s) => s.signUp);
  const signIn = useAuthStore((s) => s.signIn);
  const saveProfile = useAuthStore((s) => s.saveProfile);

  const [mode, setMode] = useState<Mode>(defaultMode);
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [needsProfile, setNeedsProfile] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameId = useId();
  const handleId = useId();
  const handleHintId = useId();
  const emailId = useId();
  const passwordId = useId();

  const previewInitials = useMemo(
    () => initialsFromLabel(displayName || handle || "?"),
    [displayName, handle],
  );
  const previewAccent = useMemo(
    () => avatarAccentFromLabel(displayName || handle || "?"),
    [displayName, handle],
  );

  const finishOrProfile = () => {
    const profile = useAuthStore.getState().profile;
    if (!profile?.handle || !profile.displayName) setNeedsProfile(true);
    else onClose();
  };

  const submit = async () => {
    if (!email.trim() || !password.trim()) return;
    setBusy(true);
    setErr(null);

    if (mode === "signup") {
      if (!displayName.trim() || !handle.trim()) {
        setErr("Enter your name and handle.");
        setBusy(false);
        return;
      }
      const r = await signUp({
        email,
        password,
        displayName: displayName.trim(),
        handle: handle.trim(),
      });
      setBusy(false);
      if (!r.ok) {
        setErr(r.error ?? "Couldn't create account.");
        return;
      }
      onClose();
      return;
    }

    const r = await signIn({ email, password });
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? "Couldn't sign in.");
      return;
    }
    finishOrProfile();
  };

  const saveMissingProfile = async () => {
    if (!displayName.trim() || !handle.trim()) {
      setErr("Enter your name and handle.");
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await saveProfile(displayName.trim(), handle.trim());
    setBusy(false);
    if (r.ok) onClose();
    else setErr(r.error ?? "Couldn't save profile.");
  };

  const title = needsProfile
    ? "Finish your profile"
    : mode === "signup"
      ? "Create your account"
      : "Sign in";

  const footer = needsProfile ? (
    <button
      className="btn btn--primary"
      onClick={() => void saveMissingProfile()}
      disabled={busy || !displayName.trim() || !handle.trim()}
    >
      {busy ? "Saving…" : "Save profile"}
    </button>
  ) : (
    <>
      <button className="btn btn--ghost" onClick={onClose}>
        Cancel
      </button>
      <button
        className="btn btn--primary"
        onClick={() => void submit()}
        disabled={
          busy ||
          !email.trim() ||
          !password.trim() ||
          (mode === "signup" && (!displayName.trim() || !handle.trim()))
        }
      >
        {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
      </button>
    </>
  );

  return (
    <Modal title={title} onClose={onClose} footer={footer}>
      {!needsProfile && (
        <div className="row gap-2" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={`btn btn--sm ${mode === "signin" ? "btn--primary" : "btn--ghost"}`}
            onClick={() => setMode("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`btn btn--sm ${mode === "signup" ? "btn--primary" : "btn--ghost"}`}
            onClick={() => setMode("signup")}
          >
            New account
          </button>
        </div>
      )}

      {(mode === "signup" || needsProfile) && (
        <>
          <div className="row gap-3" style={{ marginBottom: 14, alignItems: "center" }}>
            <div
              className="avatar"
              style={{
                background: previewAccent,
                width: 44,
                height: 44,
                fontSize: 15,
                fontWeight: 700,
              }}
              aria-hidden
            >
              {previewInitials}
            </div>
            <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
              Your avatar uses your name initials.
            </p>
          </div>
          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input
              id={nameId}
              autoFocus
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div className="field">
            <label htmlFor={handleId}>Handle</label>
            <input
              id={handleId}
              aria-describedby={handleHintId}
              value={handle}
              onChange={(e) => setHandle(e.target.value.replace(/\s/g, ""))}
              placeholder="your_handle"
            />
            <p id={handleHintId} className="text-faint" style={{ fontSize: 12, marginTop: 6 }}>
              Friends search for this (letters, numbers, underscores).
            </p>
          </div>
        </>
      )}

      {!needsProfile && (
        <>
          <div className="field">
            <label htmlFor={emailId}>Email</label>
            <input
              id={emailId}
              autoFocus={mode === "signin"}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              placeholder="you@example.com"
            />
          </div>
          <div className="field">
            <label htmlFor={passwordId}>Password</label>
            <input
              id={passwordId}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              placeholder="At least 6 characters"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </div>
        </>
      )}

      {err && (
        <p role="alert" style={{ color: "var(--bear, #e85d6f)", fontSize: 13, marginTop: 8 }}>
          {err}
        </p>
      )}
    </Modal>
  );
}
