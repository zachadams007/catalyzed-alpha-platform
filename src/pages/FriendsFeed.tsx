import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { initialsFromLabel } from "@/lib/profileDisplay";
import type { Profile } from "@/data/supabase/friends";
import { SignInModal } from "@/components/auth/SignInModal";
import { SignalCard } from "@/components/signal/SignalCard";
import { PageHeader } from "@/components/common/PageHeader";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import { IconPlus, IconCheck, IconClose, IconFriends, IconSearch, IconShare } from "@/components/icons";
import { relativeTime } from "@/lib/format";
import { listProfiles } from "@/data/supabase/friends";

function initials(p: Profile): string {
  return initialsFromLabel(p.displayName || p.handle || "??");
}
const atHandle = (p: Profile) => (p.handle ? `@${p.handle}` : "(no handle yet)");

/** One person row used in search results, requests and the friends list. */
function PersonRow({
  profile,
  children,
}: {
  profile: Profile;
  children: ReactNode;
}) {
  return (
    <div className="person-card">
      <div className="avatar person-card__avatar" style={{ background: profile.avatarAccent }}>
        {initials(profile)}
      </div>
      <div className="person-card__id">
        <span className="person-card__name">{profile.displayName || profile.handle}</span>
        <span className="text-faint mono person-card__handle">
          {atHandle(profile)}
        </span>
      </div>
      <div className="row gap-2 person-card__actions">
        {children}
      </div>
    </div>
  );
}

function HandleSetupCard({ onDone }: { onDone: () => void }) {
  const saveProfile = useAuthStore((s) => s.saveProfile);
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!displayName.trim() || !handle.trim()) return;
    setBusy(true);
    setErr(null);
    const r = await saveProfile(displayName.trim(), handle.trim());
    setBusy(false);
    if (r.ok) onDone();
    else setErr(r.error ?? "Couldn't save profile.");
  };

  return (
    <div className="card friends-setup">
      <h3 className="friends-setup__title">Finish your profile</h3>
      <p className="text-muted friends-setup__hint">
        Add your name (for your avatar initials) and a handle friends can search for.
      </p>
      <div className="field">
        <label>Name</label>
        <input
          autoFocus
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Your name"
        />
      </div>
      <div className="field">
        <label>Handle</label>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value.replace(/\s/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder="your_handle"
        />
      </div>
      <button
        className="btn btn--primary friends-setup__save"
        onClick={() => void save()}
        disabled={busy || !displayName.trim() || !handle.trim()}
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {err && (
        <p className="friends-setup__error">{err}</p>
      )}
    </div>
  );
}

function SignedInFriends() {
  const email = useAuthStore((s) => s.email);
  const profile = useAuthStore((s) => s.profile);
  const backendError = useAuthStore((s) => s.backendError);
  const friends = useAuthStore((s) => s.friends);
  const incoming = useAuthStore((s) => s.incoming);
  const outgoing = useAuthStore((s) => s.outgoing);
  const shares = useAuthStore((s) => s.shares);
  const addFriend = useAuthStore((s) => s.addFriend);
  const respond = useAuthStore((s) => s.respond);
  const unfriend = useAuthStore((s) => s.unfriend);
  const shareTicker = useAuthStore((s) => s.shareTicker);
  const signOut = useAuthStore((s) => s.signOut);

  const resolveSignal = useAppStore((s) => s.resolveSignal);
  const pushToast = useAppStore((s) => s.pushToast);

  const [q, setQ] = useState("");
  const [directory, setDirectory] = useState<Profile[]>([]);
  const [directoryStatus, setDirectoryStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [directoryError, setDirectoryError] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);
  const [shareT, setShareT] = useState("");
  const [shareNote, setShareNote] = useState("");

  const loadDirectory = async () => {
    const userId = useAuthStore.getState().userId;
    if (!userId) return;
    setDirectoryStatus("loading");
    setDirectoryError("");
    try {
      setDirectory(await listProfiles(userId));
      setDirectoryStatus("ready");
    } catch (error) {
      setDirectoryStatus("error");
      setDirectoryError(error instanceof Error ? error.message : "Couldn't load the people directory.");
    }
  };

  const doAdd = async (p: Profile) => {
    setAddingId(p.id);
    const r = await addFriend(p.id);
    setAddingId(null);
    if (r.ok) pushToast(`Friend request sent to ${atHandle(p)}`, "success");
    else pushToast(r.error ?? "Couldn't send request", "warn");
  };

  useEffect(() => {
    void loadDirectory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleDirectory = useMemo(() => {
    const needle = q.trim().replace(/^@+/, "").toLowerCase();
    if (!needle) return directory;
    return directory.filter(
      (person) =>
        person.handle?.toLowerCase().includes(needle) ||
        person.displayName?.toLowerCase().includes(needle),
    );
  }, [directory, q]);

  const friendIds = useMemo(() => new Set(friends.map((item) => item.profile.id)), [friends]);
  const outgoingIds = useMemo(
    () => new Set(outgoing.map((item) => item.profile.id)),
    [outgoing],
  );
  const incomingById = useMemo(
    () => new Map(incoming.map((item) => [item.profile.id, item])),
    [incoming],
  );

  const doShare = async () => {
    const t = shareT.trim().toUpperCase();
    const r = await shareTicker(t, shareNote);
    if (r.ok) {
      pushToast(`Shared ${t} with your friends`, "success");
      setShareT("");
      setShareNote("");
    } else {
      pushToast(r.error ?? "Couldn't share", "warn");
    }
  };

  return (
    <>
      <PageHeader
        title="Friends"
        description="People you know who also use Catalyzed Alpha. Add each other, then share stocks back and forth."
        action={
          <button className="btn btn--ghost btn--sm" onClick={() => void signOut()}>
            Sign out
          </button>
        }
      />

      <div className="origin-banner origin-banner--friend">
        Signed in as <strong>{email ?? "you"}</strong>
        {profile?.handle ? (
          <> (<span className="mono">{atHandle(profile)}</span>)</>
        ) : null}
        . Friends are mutual — they appear once both of you accept.
      </div>

      {backendError && (
        <div className="origin-banner origin-banner--warn friends-block">
          The friends service hit a problem — contact the operator if this persists.
        </div>
      )}

      {!profile?.handle || !profile?.displayName ? (
        <HandleSetupCard onDone={() => void useAuthStore.getState().refresh()} />
      ) : null}

      {/* ---- People directory --------------------------------------------- */}
      <section className="friends-directory" aria-labelledby="friends-directory-title">
        <div className="friends-directory__head">
          <div>
            <div className="section-title" id="friends-directory-title">
              People on Catalyzed Alpha
            </div>
            <p>Browse completed profiles and send a mutual friend request.</p>
          </div>
          {directoryStatus === "ready" && (
            <span className="friends-directory__count mono">{directory.length}</span>
          )}
        </div>

        <label className="friends-directory__search">
          <IconSearch size={16} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name or handle"
            aria-label="Filter people by name or handle"
          />
        </label>

        {directoryStatus === "loading" ? (
          <>
            <LoadingNote
              label="people"
              hint="Fetching the member directory — a moment, not stuck."
            />
            <div className="people-grid friends-directory__grid" aria-busy="true">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="person-card friends-directory__skeleton" key={index}>
                  <span className="skeleton friends-directory__skeleton-avatar" />
                  <span className="skeleton friends-directory__skeleton-copy" />
                </div>
              ))}
            </div>
          </>
        ) : directoryStatus === "error" ? (
          <div className="empty friends-directory__state" role="alert">
            <h3>People directory unavailable</h3>
            <p>{directoryError}</p>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void loadDirectory()}>
              Try again
            </button>
          </div>
        ) : visibleDirectory.length > 0 ? (
          <div className="people-grid friends-directory__grid">
            {visibleDirectory.map((p) => {
              const incomingRequest = incomingById.get(p.id);
              return (
                <PersonRow key={p.id} profile={p}>
                  {friendIds.has(p.id) ? (
                    <span className="origin-pill origin-pill--friend">
                      <IconCheck size={13} /> Friends
                    </span>
                  ) : outgoingIds.has(p.id) ? (
                    <span className="origin-pill origin-pill--suggested">Request sent</span>
                  ) : incomingRequest ? (
                    <>
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => void respond(incomingRequest.friendshipId, true)}
                      >
                        <IconCheck size={14} /> Accept
                      </button>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => void respond(incomingRequest.friendshipId, false)}
                      >
                        <IconClose size={14} /> Decline
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={() => void doAdd(p)}
                      disabled={addingId === p.id}
                    >
                      <IconPlus size={14} /> {addingId === p.id ? "Sending..." : "Add friend"}
                    </button>
                  )}
                </PersonRow>
              );
            })}
          </div>
        ) : (
          <div className="empty friends-directory__state">
            <h3>{q.trim() ? "No matching people" : "No other profiles yet"}</h3>
            <p>
              {q.trim()
                ? "Try a shorter name or handle."
                : "New members will appear here after they finish their profile."}
            </p>
          </div>
        )}
      </section>

      {/* ---- Incoming requests -------------------------------------------- */}
      {incoming.length > 0 && (
        <>
          <div className="section-title row gap-2">
            Friend requests
            <span className="origin-pill origin-pill--friend">{incoming.length}</span>
          </div>
          <div className="people-grid friends-block">
            {incoming.map((r) => (
              <PersonRow key={r.friendshipId} profile={r.profile}>
                <button
                  className="btn btn--primary btn--sm"
                  onClick={() => void respond(r.friendshipId, true)}
                >
                  <IconCheck size={14} /> Accept
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => void respond(r.friendshipId, false)}
                >
                  <IconClose size={14} /> Decline
                </button>
              </PersonRow>
            ))}
          </div>
        </>
      )}

      {/* ---- Your friends + share composer -------------------------------- */}
      <div className="section-title">Your friends</div>
      {friends.length > 0 ? (
        <div className="people-grid friends-block">
          {friends.map((f) => (
            <PersonRow key={f.friendshipId} profile={f.profile}>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => void unfriend(f.friendshipId)}
              >
                <IconClose size={14} /> Remove
              </button>
            </PersonRow>
          ))}
        </div>
      ) : (
        <div className="empty friends-block">
          <p>No friends yet. Add someone from the people directory above to send your first request.</p>
        </div>
      )}

      {outgoing.length > 0 && (
        <p className="text-faint friends-pending">
          Pending: {outgoing.map((r) => atHandle(r.profile)).join(", ")}
        </p>
      )}

      {friends.length > 0 && (
        <div className="card friends-share">
          <div className="act-group-label friends-share__label">
            Share a ticker with your friends
          </div>
          <div className="friends-share__row">
            <input
              className="friends-share__ticker"
              value={shareT}
              onChange={(e) => setShareT(e.target.value)}
              placeholder="Ticker (e.g. NVDA)"
            />
            <input
              className="friends-share__note"
              value={shareNote}
              onChange={(e) => setShareNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && shareT.trim() && void doShare()}
              placeholder="Why it's interesting (optional)"
            />
            <button className="btn btn--primary" onClick={() => void doShare()} disabled={!shareT.trim()}>
              <IconShare size={15} /> Share
            </button>
          </div>
        </div>
      )}

      {/* ---- Shared with you ---------------------------------------------- */}
      <div className="section-title row gap-2">
        Shared with you
        <span className="origin-pill origin-pill--friend">Friend share</span>
      </div>
      {shares.length > 0 ? (
        <div className="feed feed--timeline">
          {shares.map((share, i) => {
            const signal = resolveSignal(share.ticker);
            return (
              <div key={share.id} className="col gap-2">
                <div className="share-row">
                  <div
                    className="avatar share-row__avatar"
                    style={{ background: share.author.avatarAccent }}
                  >
                    {initials(share.author)}
                  </div>
                  <div className="col">
                    <span className="share-row__name">
                      <strong>{share.author.displayName || share.author.handle}</strong>{" "}
                      <span className="text-faint">{atHandle(share.author)}</span>
                    </span>
                    {share.note && (
                      <span className="text-muted share-row__note">
                        “{share.note}”
                      </span>
                    )}
                  </div>
                  <span className="text-faint share-row__time">
                    {relativeTime(share.createdAt)}
                  </span>
                </div>
                {signal ? (
                  <SignalCard signal={signal} index={i} />
                ) : (
                  <Link to={`/signal/${share.ticker}`} className="card share-fallback">
                    <span className="ticker mono share-fallback__ticker">
                      {share.ticker}
                    </span>
                    <span className="text-faint share-fallback__hint">
                      Open in Ticker Scope →
                    </span>
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <p>Nothing shared yet. When you or a friend shares a ticker, it shows up here.</p>
        </div>
      )}

      <InvestingDisclaimer className="page-disclaimer" />
    </>
  );
}

export function FriendsFeed() {
  const configured = useAuthStore((s) => s.configured);
  const ready = useAuthStore((s) => s.ready);
  const userId = useAuthStore((s) => s.userId);
  const [showSignIn, setShowSignIn] = useState(false);

  // Signed in → the real thing.
  if (configured && userId) return <SignedInFriends />;

  return (
    <>
      <PageHeader
        title="Friends"
        description="Connect with people you actually know who also use Catalyzed Alpha — see what they're sharing and share back."
      />

      {configured ? (
        <div className="empty friends-block">
          <IconFriends size={28} />
          <h3>Sign in to connect with friends</h3>
          <p>
            Create an account with your name and email, or sign in with the password you chose.
            Friends search for your handle to connect.
          </p>
          <button
            className="btn btn--primary"
            onClick={() => setShowSignIn(true)}
            disabled={!ready}
          >
            Sign in
          </button>
        </div>
      ) : (
        <div className="empty friends-block">
          <IconFriends size={28} />
          <h3>Social features are coming soon</h3>
          <p>
            Friends, shared watchlists, and social feeds are on the roadmap. Stay tuned for updates.
          </p>
        </div>
      )}

      <InvestingDisclaimer className="page-disclaimer" />

      {showSignIn && <SignInModal onClose={() => setShowSignIn(false)} />}
    </>
  );
}
