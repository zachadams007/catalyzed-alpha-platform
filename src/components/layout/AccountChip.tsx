import { useCallback, useRef, useState } from "react";
import { SignInModal } from "@/components/auth/SignInModal";
import { Popover } from "@/components/common/Popover";
import { IconUser } from "@/components/icons";
import { initialsFromLabel } from "@/lib/profileDisplay";
import {
  getAvatar,
  setAvatar,
  removeAvatar,
  compressImageFile,
} from "@/lib/avatarStore";
import { useAuthStore } from "@/store/useAuthStore";

/**
 * Account control shared by the desktop sidebar and compact mobile top bar.
 * Auth state and SignInModal ownership stay here so both placements behave alike.
 */

/** Camera SVG icon (inline - no extra dependency). */
function IconCamera({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6.2 2 5.2 3.5H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-3.2L9.8 2H6.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8.5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * Hook that keeps avatar data-URL in React state, synced to/from localStorage.
 * Re-reads from storage whenever `userId` changes.
 */
function useAvatarState(userId: string | null) {
  const [dataUrl, setDataUrl] = useState<string | null>(() => getAvatar(userId));

  // Update if userId changes (sign-in / sign-out)
  const prevUserId = useRef(userId);
  if (prevUserId.current !== userId) {
    prevUserId.current = userId;
    const next = getAvatar(userId);
    if (next !== dataUrl) setDataUrl(next);
  }

  const save = useCallback(
    (url: string) => {
      setAvatar(userId, url);
      setDataUrl(url);
    },
    [userId],
  );

  const clear = useCallback(() => {
    removeAvatar(userId);
    setDataUrl(null);
  }, [userId]);

  return { dataUrl, save, clear };
}

/**
 * Avatar element with an optional "change photo" overlay.
 * Renders the uploaded photo (or falls back to initials/content).
 */
interface AvatarBubbleProps {
  userId: string | null;
  /** CSS class names to forward (e.g. "avatar account-chip__compact-avatar"). */
  className: string;
  style?: React.CSSProperties;
  /** Fallback children (initials text or "YOU"). */
  children?: React.ReactNode;
  /** Whether to show the camera upload affordance. */
  editable?: boolean;
  dataUrl: string | null;
  onSave: (url: string) => void;
}

function AvatarBubble({
  className,
  style,
  children,
  editable = false,
  dataUrl,
  onSave,
}: AvatarBubbleProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Reset so picking the same file again still triggers onChange
      e.target.value = "";
      void compressImageFile(file).then(onSave).catch(console.error);
    },
    [onSave],
  );

  return (
    <div className={`avatar-wrap ${className}`} style={style}>
      {dataUrl ? (
        <img className="avatar-photo" src={dataUrl} alt="Profile photo" />
      ) : (
        children
      )}
      {editable && (
        <>
          <button
            type="button"
            className="avatar-camera-btn"
            title="Change profile photo"
            aria-label="Change profile photo"
            onClick={() => inputRef.current?.click()}
          >
            <IconCamera size={11} />
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="avatar-file-input"
            onChange={handleFileChange}
          />
        </>
      )}
    </div>
  );
}

export function AccountChip({ compact = false }: { compact?: boolean }) {
  const configured = useAuthStore((s) => s.configured);
  const ready = useAuthStore((s) => s.ready);
  const userId = useAuthStore((s) => s.userId);
  const email = useAuthStore((s) => s.email);
  const profile = useAuthStore((s) => s.profile);
  const signOut = useAuthStore((s) => s.signOut);
  const [showSignIn, setShowSignIn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  const { dataUrl, save, clear } = useAvatarState(userId);

  // ── Not configured (local-only) ──────────────────────────────────────────
  // userId is null here, so useAvatarState already tracks the "local" key reactively.
  if (!configured) {
    if (compact) {
      return (
        <div className="account-chip account-chip--compact account-chip--local" title="Local profile">
          <AvatarBubble
            userId={null}
            className="avatar account-chip__compact-avatar"
            editable
            dataUrl={dataUrl}
            onSave={save}
          >
            YOU
          </AvatarBubble>
          <span className="account-chip__compact-label">Local</span>
        </div>
      );
    }

    return (
      <div className="user-chip">
        <AvatarBubble
          userId={null}
          className="avatar"
          editable
          dataUrl={dataUrl}
          onSave={save}
        >
          YOU
        </AvatarBubble>
        <div className="col account-chip__identity">
          <span className="account-chip__name">Your Desk</span>
          <span className="text-faint account-chip__sub">Local profile</span>
        </div>
      </div>
    );
  }

  // ── Signed in ─────────────────────────────────────────────────────────────
  if (userId) {
    const name = profile?.displayName || email?.split("@")[0] || "You";
    const handle = profile?.handle ? `@${profile.handle}` : "Synced across devices";
    const accent = profile?.avatarAccent ?? "var(--accent)";

    if (compact) {
      return (
        <div className="account-chip account-chip--compact">
          <button
            ref={menuAnchorRef}
            type="button"
            className="account-chip__compact-trigger"
            aria-label={`Open account menu for ${name}`}
            aria-expanded={menuOpen}
            title={name}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <AvatarBubble
              userId={userId}
              className="avatar account-chip__compact-avatar"
              style={{ background: dataUrl ? undefined : accent }}
              editable={false}
              dataUrl={dataUrl}
              onSave={save}
            >
              {initialsFromLabel(name)}
            </AvatarBubble>
          </button>
          <Popover
            anchorRef={menuAnchorRef}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            placement="bottom"
            align="end"
            role="menu"
            ariaLabel="Account menu"
          >
          <div className="account-chip__menu">
            <div className="account-chip__menu-identity">
              <span className="account-chip__name">{name}</span>
              <span className="text-faint account-chip__sub">{handle}</span>
            </div>
            {/* Change photo row inside the dropdown menu */}
            <AvatarPhotoControls
              userId={userId}
              dataUrl={dataUrl}
              onSave={save}
              onClear={clear}
            />
            <button
              type="button"
              className="account-chip__signout"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void signOut();
              }}
            >
              Sign out
            </button>
          </div>
          </Popover>
        </div>
      );
    }

    return (
      <div className="user-chip">
        <AvatarBubble
          userId={userId}
          className="avatar"
          style={{ background: dataUrl ? undefined : accent }}
          editable
          dataUrl={dataUrl}
          onSave={save}
        >
          {initialsFromLabel(name)}
        </AvatarBubble>
        <div className="col grow account-chip__identity">
          <span className="account-chip__name">{name}</span>
          <span className="text-faint account-chip__sub">{handle}</span>
        </div>
        <button
          type="button"
          className="account-chip__signout"
          title="Sign out"
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </div>
    );
  }

  // ── Signed out ────────────────────────────────────────────────────────────
  if (compact) {
    return (
      <>
        <button
          type="button"
          className="account-chip account-chip--compact account-chip__compact-signin"
          disabled={!ready}
          onClick={() => setShowSignIn(true)}
          aria-label="Sign in to sync portfolios"
        >
          <IconUser size={15} />
          <span>Sign in</span>
        </button>
        {showSignIn && <SignInModal onClose={() => setShowSignIn(false)} />}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className="account-chip__signin"
        disabled={!ready}
        onClick={() => setShowSignIn(true)}
      >
        <div className="avatar account-chip__avatar--ghost">
          <IconUser size={16} />
        </div>
        <div className="col account-chip__signin-copy">
          <span className="account-chip__name">Sign in</span>
          <span className="text-faint account-chip__sub">Sync portfolios across devices</span>
        </div>
      </button>
      {showSignIn && <SignInModal onClose={() => setShowSignIn(false)} />}
    </>
  );
}

// ── Helper: photo controls for the compact dropdown ──────────────────────────

interface AvatarPhotoControlsProps {
  userId: string | null;
  dataUrl: string | null;
  onSave: (url: string) => void;
  onClear: () => void;
}

function AvatarPhotoControls({
  dataUrl,
  onSave,
  onClear,
}: AvatarPhotoControlsProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      void compressImageFile(file).then(onSave).catch(console.error);
    },
    [onSave],
  );

  return (
    <>
      <button
        type="button"
        className="account-chip__signout"
        style={{ borderTop: "1px solid var(--border)" }}
        onClick={() => inputRef.current?.click()}
      >
        {dataUrl ? "Change photo" : "Upload photo"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="avatar-file-input"
        onChange={handleFileChange}
      />
      {dataUrl && (
        <button type="button" className="avatar-remove-btn" onClick={onClear}>
          Remove photo
        </button>
      )}
    </>
  );
}
