import "@/styles/groups.css";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/store/useAuthStore";
import { useGroupsStore } from "@/store/useGroupsStore";
import { useAppStore } from "@/store/useAppStore";
import { PageHeader } from "@/components/common/PageHeader";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { SignInModal } from "@/components/auth/SignInModal";
import { IconCheck } from "@/components/icons";
import { IconGroups, IconLink, IconTrophy } from "@/components/groups/icons";
import { IconWatchlist } from "@/components/icons";
import { MyGroupsRail } from "@/components/groups/MyGroupsRail";
import { GroupDetail } from "@/components/groups/GroupDetail";
import { CreateOrJoin } from "@/components/groups/CreateOrJoin";
import { PendingInvites } from "@/components/groups/PendingInvites";
import { tokenFromInvite } from "@/components/groups/invite";
import type { InvitePreview } from "@/data/groups/types";

const PAGE_DESC =
  "Private, invite-only spaces for your circle — a shared watchlist and a call leaderboard that ranks picks by real performance. Opt-in: the rest of Catalyzed works without ever joining one.";

/** Three feature tiles for the signed-out / welcome states. */
function FeatureTiles() {
  return (
    <div className="grp-tiles">
      <div className="grp-tile">
        <span className="grp-tile__icon"><IconLink size={18} /></span>
        <h4>One invite link</h4>
        <p>Drop a link in your group chat. Everyone taps in — no one-by-one adds.</p>
      </div>
      <div className="grp-tile">
        <span className="grp-tile__icon"><IconWatchlist size={18} /></span>
        <h4>Shared watchlist</h4>
        <p>The names your group is watching, in one place, with live prices.</p>
      </div>
      <div className="grp-tile">
        <span className="grp-tile__icon"><IconTrophy size={18} /></span>
        <h4>Call leaderboard</h4>
        <p>Call a stock — publicly back it — and we track it from that price, so you can see whose picks actually win.</p>
      </div>
    </div>
  );
}

/** Banner shown when the user arrived via an invite link. */
function InviteBanner({ token, onClear }: { token: string; onClear: () => void }) {
  const peek = useGroupsStore((s) => s.peek);
  const joinByToken = useGroupsStore((s) => s.joinByToken);
  const selectGroup = useGroupsStore((s) => s.selectGroup);
  const groups = useGroupsStore((s) => s.groups);
  const pushToast = useAppStore((s) => s.pushToast);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void peek(token).then((p) => live && setPreview(p));
    return () => {
      live = false;
    };
  }, [token, peek]);

  if (preview && !preview.valid) {
    return (
      <div className="grp-invite-banner grp-invite-banner--bad" role="alert">
        <span>That invite link isn't valid anymore. Ask your group for a fresh one.</span>
        <button className="grp-textbtn" onClick={onClear}>Dismiss</button>
      </div>
    );
  }
  if (!preview || !preview.groupName) return null;

  const alreadyIn = preview.groupId != null && groups.some((g) => g.id === preview.groupId);

  const join = async () => {
    setBusy(true);
    try {
      if (alreadyIn && preview.groupId) {
        await selectGroup(preview.groupId);
        onClear();
        return;
      }
      const r = await joinByToken(token);
      if (r.ok) {
        pushToast(`Joined ${r.groupName ?? preview.groupName}.`, "success");
        onClear();
      } else {
        pushToast(r.error ?? "Couldn't join.", "warn");
      }
    } catch {
      // Supabase reject (network/RLS) must not leave the button stuck on "…".
      pushToast("Couldn’t open that group right now — try again.", "warn");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grp-invite-banner">
      <span className="grp-invite-banner__icon"><IconGroups size={18} /></span>
      <div className="grp-invite-banner__copy">
        <strong>{alreadyIn ? "You're already in" : "You're invited to"} {preview.groupName}</strong>
        <span className="text-faint">
          {preview.memberCount} member{preview.memberCount === 1 ? "" : "s"}
        </span>
      </div>
      <button className="btn btn--primary btn--sm" onClick={() => void join()} disabled={busy}>
        {busy ? "…" : alreadyIn ? "Open" : "Join"}
      </button>
      <button className="grp-textbtn" onClick={onClear}>Not now</button>
    </div>
  );
}

function SignedInGroups({ joinToken, onClearToken }: { joinToken: string; onClearToken: () => void }) {
  const groups = useGroupsStore((s) => s.groups);
  const groupsStatus = useGroupsStore((s) => s.groupsStatus);
  const groupsError = useGroupsStore((s) => s.groupsError);
  const activeId = useGroupsStore((s) => s.activeId);
  const loadMyGroups = useGroupsStore((s) => s.loadMyGroups);
  const selectGroup = useGroupsStore((s) => s.selectGroup);

  // loadMyGroups + the cross-group activity channel are now driven app-level by
  // initGroupsSync (App.tsx), so the rail's unread dots stay live off /groups and
  // a sign-out resets the store everywhere - no page-mount load needed here.

  // Auto-open the most recent group once loaded (unless we're resolving an invite).
  const autoSelected = useRef(false);
  useEffect(() => {
    if (joinToken) return;
    if (groupsStatus === "ready" && !activeId && groups.length > 0 && !autoSelected.current) {
      autoSelected.current = true;
      void selectGroup(groups[0]!.id);
    }
  }, [groupsStatus, activeId, groups, selectGroup, joinToken]);

  const activeSummary = groups.find((g) => g.id === activeId) ?? null;

  return (
    <>
      <PageHeader title="Groups" description={PAGE_DESC} />

      {joinToken && <InviteBanner token={joinToken} onClear={onClearToken} />}

      <PendingInvites />

      {groupsStatus === "loading" && groups.length === 0 ? (
        <div className="grp-rail" aria-busy="true">
          <LoadingNote
            label="your groups"
            hint="Fetching your spaces and members — a moment, not stuck."
          />
          <div className="grp-rail__scroll">
            {Array.from({ length: 3 }, (_, i) => (
              <span key={i} className="skeleton grp-skel grp-skel--card" />
            ))}
          </div>
        </div>
      ) : groupsStatus === "error" ? (
        <div className="empty grp-empty" role="alert">
          <h3>Couldn't load your groups</h3>
          <p>{groupsError}</p>
          <button className="btn btn--ghost btn--sm" onClick={() => void loadMyGroups()}>
            Try again
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div className="grp-welcome">
          <div className="grp-welcome__intro">
            <span className="grp-welcome__badge"><IconGroups size={26} /></span>
            <h2>Start your first group</h2>
            <p className="text-muted">
              Bring your finance group chat into Catalyzed. Create a space and share one invite link, or join with a link someone sent you.
            </p>
            <FeatureTiles />
          </div>
          <CreateOrJoin prefillToken={joinToken} />
        </div>
      ) : (
        <>
          <MyGroupsRail />
          {activeSummary ? (
            <GroupDetail summary={activeSummary} />
          ) : (
            <div className="empty grp-empty">
              <IconGroups size={24} />
              <p>Pick a group above to open it.</p>
            </div>
          )}
        </>
      )}

      <InvestingDisclaimer className="page-disclaimer" />
    </>
  );
}

export function Groups() {
  const configured = useAuthStore((s) => s.configured);
  const ready = useAuthStore((s) => s.ready);
  const userId = useAuthStore((s) => s.userId);
  const [params, setParams] = useSearchParams();
  const [showSignIn, setShowSignIn] = useState(false);

  const joinToken = tokenFromInvite(params.get("join") ?? "");
  const clearToken = () => {
    const next = new URLSearchParams(params);
    next.delete("join");
    setParams(next, { replace: true });
  };

  // Sign-out reset is handled app-level by initGroupsSync (App.tsx), so group
  // state is cleared everywhere - not only when the /groups page is mounted.

  if (configured && userId) {
    return <SignedInGroups joinToken={joinToken} onClearToken={clearToken} />;
  }

  return (
    <>
      <PageHeader title="Groups" description={PAGE_DESC} />

      {configured ? (
        <div className="grp-welcome">
          <div className="grp-welcome__intro">
            <span className="grp-welcome__badge"><IconGroups size={26} /></span>
            <h2>{joinToken ? "You've been invited to a group" : "Private spaces for your circle"}</h2>
            <p className="text-muted">
              {joinToken
                ? "Sign in or create a free account to join — then you're in with the rest of your group."
                : "Sign in to create a group or join one from an invite link. Groups are opt-in — everything else in Catalyzed works without one."}
            </p>
            <FeatureTiles />
            <button className="btn btn--primary grp-welcome__cta" onClick={() => setShowSignIn(true)} disabled={!ready}>
              {joinToken ? "Sign in to join" : "Sign in to get started"}
            </button>
            {joinToken && (
              <p className="text-faint grp-welcome__invitenote">
                <IconCheck size={13} /> Your invite is saved — we'll take you straight in after sign-in.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="empty grp-empty">
          <IconGroups size={28} />
          <h3>Groups need an account backend</h3>
          <p>
            Groups are multi-user, so they run on Supabase. Add your <span className="mono">VITE_SUPABASE_URL</span> and{" "}
            <span className="mono">VITE_SUPABASE_ANON_KEY</span> (and apply the groups migration) to turn this on.
          </p>
        </div>
      )}

      <InvestingDisclaimer className="page-disclaimer" />

      {showSignIn && (
        <SignInModal
          defaultMode={joinToken ? "signup" : "signin"}
          onClose={() => setShowSignIn(false)}
        />
      )}
    </>
  );
}
