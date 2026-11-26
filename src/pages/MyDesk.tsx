import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { supabase } from "@/data/supabase/client";
import { UsagePanel } from "@/components/layout/UsagePanel";
import { useApiUsage } from "@/components/ops/ApiQuotaBoard";
import { EngineOpsSection } from "@/components/ops/EngineOpsSection";
import { QUALITY_COPY } from "@/lib/apiUsage";
import { Loader } from "@/components/common/Loader";
import { SignInModal } from "@/components/auth/SignInModal";
import { IconUser } from "@/components/icons";
import { getAvatar } from "@/lib/avatarStore";
import { initialsFromLabel } from "@/lib/profileDisplay";

/**
 * Your Desk - the per-user dashboard. Everything here is the signed-in
 * user's own data: identity, profile editing, on-device engine activity,
 * library counts, and this device's API spend. Works in three modes:
 * Supabase unconfigured (local desk), signed out (join CTA), signed in.
 */

function DeviceCard() {
  const snapshot = useApiUsage();
  const quality = QUALITY_COPY[snapshot.quality];
  return (
    <div className="ops-card">
      <div className="ops-card__title">This device</div>
      <div className="row-between" style={{ marginBottom: "var(--sp-3)" }}>
        <span className="text-muted" style={{ fontSize: 13 }}>
          API calls today
        </span>
        <span className="mono" style={{ fontWeight: 600 }}>
          {snapshot.totalToday}
        </span>
      </div>
      <div className="row-between">
        <span className="text-muted" style={{ fontSize: 13 }}>
          Data quality
        </span>
        <span className={`quality-chip quality-chip--${snapshot.quality}`}>
          <span className="quality-chip__dot" aria-hidden="true" />
          {quality.label}
        </span>
      </div>
      <p className="text-faint" style={{ fontSize: "var(--type-sm)", margin: "var(--sp-2) 0 0" }}>
        {quality.detail}
      </p>
      <p className="text-faint" style={{ fontSize: 12, marginTop: "var(--sp-3)", marginBottom: 0 }}>
        Full per-source gauges are in <strong>Research automation</strong> below.
      </p>
    </div>
  );
}

function LibraryCard() {
  const watchlistCount = useAppStore((s) => s.watchlist.length);
  const portfolioCount = useAppStore((s) => s.portfolios.filter((p) => p.owner === "me").length);
  return (
    <div className="ops-card">
      <div className="ops-card__title">Your library</div>
      <div className="desk-stat-row">
        <Link to="/watchlist" className="usage-tile usage-tile--link">
          <div className="usage-tile__value mono">{watchlistCount}</div>
          <div className="usage-tile__label">Watchlist</div>
        </Link>
        <Link to="/portfolios" className="usage-tile usage-tile--link">
          <div className="usage-tile__value mono">{portfolioCount}</div>
          <div className="usage-tile__label">Portfolios</div>
        </Link>
      </div>
    </div>
  );
}

function FriendsCard() {
  const friends = useAuthStore((s) => s.friends);
  const incoming = useAuthStore((s) => s.incoming);
  return (
    <div className="ops-card">
      <div className="ops-card__title">Friends</div>
      {friends.length === 0 && incoming.length === 0 ? (
        <div className="empty" style={{ padding: "var(--sp-4)" }}>
          <p style={{ margin: 0 }}>
            No friends yet — find people on the <Link to="/friends">Friends tab</Link> and share
            tickers.
          </p>
        </div>
      ) : (
        <div className="desk-stat-row" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Link to="/friends" className="usage-tile usage-tile--link">
            <div className="usage-tile__value mono">{friends.length}</div>
            <div className="usage-tile__label">Friends</div>
          </Link>
          <Link to="/friends" className="usage-tile usage-tile--link">
            <div className="usage-tile__value mono">{incoming.length}</div>
            <div className="usage-tile__label">Requests waiting</div>
          </Link>
        </div>
      )}
    </div>
  );
}

function ProfileEditor() {
  const profile = useAuthStore((s) => s.profile);
  const saveProfile = useAuthStore((s) => s.saveProfile);
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Re-seed the form when the profile loads/changes elsewhere.
  useEffect(() => {
    setDisplayName(profile?.displayName ?? "");
    setHandle(profile?.handle ?? "");
  }, [profile?.displayName, profile?.handle]);

  const dirty =
    displayName.trim() !== (profile?.displayName ?? "") ||
    handle.trim().replace(/^@+/, "") !== (profile?.handle ?? "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || !handle.trim()) {
      setFeedback({ ok: false, text: "Both a display name and a handle are required." });
      return;
    }
    setSaving(true);
    setFeedback(null);
    const res = await saveProfile(displayName, handle);
    setSaving(false);
    setFeedback(
      res.ok
        ? { ok: true, text: "Saved — synced across your devices." }
        : { ok: false, text: res.error ?? "Couldn't save — try again." },
    );
  };

  return (
    <div className="ops-card">
      <div className="ops-card__title">Profile</div>
      <form onSubmit={submit} className="col gap-3">
        <div className="field">
          <label htmlFor="desk-display-name">Display name</label>
          <input
            id="desk-display-name"
            value={displayName}
            maxLength={40}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name"
          />
        </div>
        <div className="field">
          <label htmlFor="desk-handle">Handle</label>
          <input
            id="desk-handle"
            value={handle}
            maxLength={24}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@handle"
          />
        </div>
        <div className="row gap-3" style={{ alignItems: "center" }}>
          <button className="btn btn--primary btn--sm" type="submit" disabled={saving || !dirty}>
            {saving ? <span className="spinner" /> : null}
            {saving ? "Saving…" : "Save profile"}
          </button>
          {feedback && (
            <span
              className={`form-feedback ${feedback.ok ? "form-feedback--ok" : "form-feedback--error"}`}
              role="status"
            >
              {feedback.text}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

export function MyDesk() {
  const configured = useAuthStore((s) => s.configured);
  const ready = useAuthStore((s) => s.ready);
  const userId = useAuthStore((s) => s.userId);
  const email = useAuthStore((s) => s.email);
  const profile = useAuthStore((s) => s.profile);
  const backendError = useAuthStore((s) => s.backendError);
  const refresh = useAuthStore((s) => s.refresh);
  const signOut = useAuthStore((s) => s.signOut);
  const [showSignIn, setShowSignIn] = useState(false);
  const [memberSince, setMemberSince] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase || !userId) {
      setMemberSince(null);
      return;
    }
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      const created = data.session?.user?.created_at;
      if (!cancelled && created) {
        setMemberSince(
          new Date(created).toLocaleDateString(undefined, { month: "short", year: "numeric" }),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (configured && !ready) {
    return <Loader text="Opening your desk…" />;
  }

  // ── Local mode (Supabase not configured) ────────────────────────────────
  if (!configured) {
    const photo = getAvatar(null);
    return (
      <>
        <div className="desk-hero">
          <div className="desk-hero__avatar" style={{ background: "var(--surface-2)" }}>
            {photo ? <img src={photo} alt="" /> : "YOU"}
          </div>
          <div>
            <div className="desk-hero__name">Your Desk</div>
            <div className="desk-hero__meta">
              <span>Local profile — lives only on this machine</span>
            </div>
          </div>
        </div>
        <div className="ops-banner">
          Cloud sync isn&apos;t configured, so there&apos;s no account to manage. Add{" "}
          <span className="mono">VITE_SUPABASE_URL</span> and{" "}
          <span className="mono">VITE_SUPABASE_ANON_KEY</span> to <span className="mono">.env</span>{" "}
          to unlock sign-in, friends, and cross-device portfolios.
        </div>
        <div className="desk-grid">
          <div className="ops-card">
            <div className="ops-card__title">Your activity</div>
            <UsagePanel />
          </div>
          <div className="col gap-4">
            <LibraryCard />
            <DeviceCard />
          </div>
        </div>
        <EngineOpsSection />
      </>
    );
  }

  // ── Signed out ──────────────────────────────────────────────────────────
  if (!userId) {
    return (
      <>
        <div className="gate-card">
          <div className="gate-card__icon" aria-hidden="true">
            <IconUser size={24} />
          </div>
          <h2>Your desk is waiting</h2>
          <p>
            Sign in to see your profile, friends, and activity in one place — and to sync
            portfolios across devices.
          </p>
          <button className="btn btn--primary" onClick={() => setShowSignIn(true)}>
            Sign in
          </button>
          {showSignIn && <SignInModal onClose={() => setShowSignIn(false)} />}
        </div>
        <div className="desk-grid" style={{ marginTop: "var(--sp-5)" }}>
          <div className="ops-card">
            <div className="ops-card__title">This device&apos;s activity</div>
            <UsagePanel />
          </div>
          <DeviceCard />
        </div>
        <EngineOpsSection />
      </>
    );
  }

  // ── Signed in ───────────────────────────────────────────────────────────
  const name = profile?.displayName || email?.split("@")[0] || "You";
  const accent = profile?.avatarAccent ?? "var(--accent)";
  const photo = getAvatar(userId);

  return (
    <>
      <div className="desk-hero">
        <div className="desk-hero__avatar" style={{ background: photo ? undefined : accent }}>
          {photo ? <img src={photo} alt="" /> : initialsFromLabel(name)}
        </div>
        <div className="grow">
          <div className="desk-hero__name">{name}</div>
          <div className="desk-hero__meta">
            {profile?.handle && <span className="mono">@{profile.handle}</span>}
            {email && <span className="mono">{email}</span>}
            {memberSince && <span>Member since {memberSince}</span>}
            <span>Synced across devices</span>
          </div>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>

      {backendError && (
        <div className="ops-banner ops-banner--error" role="alert">
          <span>{backendError}</span>
          <button
            className="btn btn--ghost btn--sm"
            style={{ marginLeft: "auto" }}
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </div>
      )}

      <div className="desk-grid">
        <div className="col gap-4">
          <ProfileEditor />
          <div className="ops-card">
            <div className="ops-card__title">Your activity</div>
            <UsagePanel />
          </div>
        </div>
        <div className="col gap-4">
          <LibraryCard />
          <FriendsCard />
          <DeviceCard />
        </div>
      </div>
      <EngineOpsSection />
    </>
  );
}
