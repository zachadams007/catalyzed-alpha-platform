import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { isAdminConfigured, isAdminEmail } from "@/lib/admin";
import {
  clearApiUsage,
  updateApiControls,
  QUALITY_COPY,
} from "@/lib/apiUsage";
import { listProfiles, type Profile } from "@/data/supabase/friends";
import { observeOnline, type OnlineUser } from "@/data/supabase/presence";
import { ApiQuotaBoard, useApiUsage } from "@/components/ops/ApiQuotaBoard";
import { ModelRegistryCard } from "@/components/ops/ModelRegistryCard";
import { useDeviceManualRefreshUsage } from "@/components/ops/RefreshLimit";
import { resetManualRefreshCount } from "@/lib/refreshLimiter";
import { UsagePanel } from "@/components/layout/UsagePanel";
import { PageHeader } from "@/components/common/PageHeader";
import { Loader } from "@/components/common/Loader";
import { Modal } from "@/components/common/Modal";
import { Skeleton } from "@/components/common/Skeleton";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import { SignInModal } from "@/components/auth/SignInModal";
import { IconRefresh, IconShield, IconTarget } from "@/components/icons";
import { initialsFromLabel } from "@/lib/profileDisplay";
import { relativeTime } from "@/lib/format";
import {
  getSampleDataModeState,
  isResearchRunAllowed,
  setSampleDataModeEnabled,
  subscribeSampleDataMode,
} from "@/data/providers";
import { IconCheck } from "@/components/icons";
import { saveOperatorSafetyPreference } from "@/data/operatorSafety";
import {
  subscribeGlobalControls,
  saveGlobalControls,
  getGlobalControls,
  DEFAULT_SCORE_SPREAD_WEIGHT,
  DEFAULT_QUALITY_CAP_STRENGTH,
} from "@/data/globalControls";
import { abortLiveDataRequests } from "@/data/http";

/** Matches every row; used to make listProfiles() include the caller too. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Live sample-data-mode state - re-renders the instant the mode flips, so the
 *  Operator Console reflects a change with no app restart. */
function useSampleDataModeState() {
  const [state, setState] = useState(getSampleDataModeState);
  useEffect(() => {
    const refresh = () => setState(getSampleDataModeState());
    // Re-render on BOTH the local sample toggle and server-side global-control
    // syncs, so the console reflects a flip from this device or any operator,
    // app-wide, with no restart.
    const unsubLocal = subscribeSampleDataMode(refresh);
    const unsubGlobal = subscribeGlobalControls(refresh);
    return () => {
      unsubLocal();
      unsubGlobal();
    };
  }, []);
  return state;
}

// ── Gate screens ──────────────────────────────────────────────────────────────

function GateCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="gate-card">
      <div className="gate-card__icon" aria-hidden="true">
        <IconShield size={24} />
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

// ── Controls ──────────────────────────────────────────────────────────────────

function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="ops-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

// ── Score-spread dial row ──────────────────────────────────────────────────────

/**
 * A single slider dial for a numeric operator knob.
 *
 * `onChange` - fires on every drag tick (live preview only, no save).
 * `onCommit` - fires on pointer-up / keyboard-up / touch-end (triggers a save).
 *
 * This two-callback split keeps the save path clean: the parent holds the
 * committed value, the local `draft` is the in-flight drag value.
 */
function DialRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  defaultValue,
  onChange,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  onChange: (next: number) => void;
  onCommit: (next: number) => void;
}) {
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const handleCommit = (next: number) => {
    onCommit(next);
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1600);
  };

  // Fill % for the CSS gradient track
  const fillPct = `${(((value - min) / (max - min)) * 100).toFixed(1)}%`;

  return (
    <div className="dial-row">
      <div className="dial-row__head">
        <div className="dial-row__label">{label}</div>
        <span className="dial-row__value mono">{value.toFixed(2)}</span>
      </div>
      <div className="dial-row__hint">{hint}</div>
      <input
        type="range"
        className="dial-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--fill": fillPct } as React.CSSProperties}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={(e) => handleCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => handleCommit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => handleCommit(Number((e.target as HTMLInputElement).value))}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className={`dial-saved${saved ? " is-visible" : ""}`} aria-live="polite">
          <IconCheck size={11} /> Saved
        </span>
        {value !== defaultValue && (
          <button
            type="button"
            className="dial-row__reset"
            onClick={() => handleCommit(defaultValue)}
            aria-label={`Reset ${label} to default (${defaultValue})`}
          >
            Reset to default ({defaultValue})
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Score-spread section - two operator dials that tune how the scoring engine
 * displays 0-100 scores. Changes are written to the global `app_controls` row
 * via `saveGlobalControls` so they propagate to every client in real-time.
 *
 * The lead engineer wires `normalizeUniverse` / `computeNormalizedScores` to
 * read the live values via `getScoreSpreadWeight()` and `getQualityCapStrength()`
 * exported from `src/data/globalControls.ts`.
 */
function ScoreSpreadSection({ email: _email }: { email: string }) {
  // Read live values from the global cache; fall back to code defaults when the
  // row hasn't loaded yet (Supabase unconfigured / still in flight).
  const live = getGlobalControls();
  const [spreadWeight, setSpreadWeight] = useState(
    live?.scoreSpreadWeight ?? DEFAULT_SCORE_SPREAD_WEIGHT,
  );
  const [capStrength, setCapStrength] = useState(
    live?.qualityCapStrength ?? DEFAULT_QUALITY_CAP_STRENGTH,
  );
  const [note, setNote] = useState<string | null>(null);

  // Re-sync when the global row updates (e.g. another operator tab changes them).
  // Skip the update while the user is dragging (local state already reflects that).
  useEffect(() => {
    return subscribeGlobalControls(() => {
      const g = getGlobalControls();
      if (!g) return;
      setSpreadWeight((prev) => (prev === g.scoreSpreadWeight ? prev : g.scoreSpreadWeight));
      setCapStrength((prev) => (prev === g.qualityCapStrength ? prev : g.qualityCapStrength));
    });
  }, []);

  const persist = async (patch: { scoreSpreadWeight?: number; qualityCapStrength?: number }) => {
    setNote(null);
    const ok = await saveGlobalControls(patch);
    if (!ok) setNote("Authorization failed — no change applied.");
  };

  return (
    <div className="ctrl-section">
      <div className="ctrl-section__label">Score display</div>
      <p className="ctrl-section__hint">
        Live dials — changes propagate to all users within seconds. These tune how the 0-100 score
        looks on cards; they never change the ranking order.
      </p>

      <DialRow
        label="Score spread"
        hint="How spread out the 0-100 scores are. Lower = scores hug their true quality; higher = scores fill the whole scale by rank. Default: 0.30."
        value={spreadWeight}
        min={0}
        max={1}
        step={0.01}
        defaultValue={DEFAULT_SCORE_SPREAD_WEIGHT}
        onChange={setSpreadWeight}
        onCommit={(v) => {
          setSpreadWeight(v);
          void persist({ scoreSpreadWeight: v });
        }}
      />

      <DialRow
        label="Quality cap"
        hint="How hard a risky or low-conviction stock's score is capped below the top. Higher = riskier picks are capped more aggressively. Default: 1.40."
        value={capStrength}
        min={0}
        max={4}
        step={0.05}
        defaultValue={DEFAULT_QUALITY_CAP_STRENGTH}
        onChange={setCapStrength}
        onCommit={(v) => {
          setCapStrength(v);
          void persist({ qualityCapStrength: v });
        }}
      />

      {note && (
        <p className="form-feedback form-feedback--error" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}

function ControlsCard({
  snapshot,
  email,
}: {
  snapshot: ReturnType<typeof useApiUsage>;
  email: string;
}) {
  const { controls } = snapshot;
  const researchStatus = useAppStore((s) => s.researchStatus);
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  const running = researchStatus === "running";
  const sampleState = useSampleDataModeState();
  const sampleDataMode = sampleState.enabled;
  const researchAllowed = isResearchRunAllowed();
  const [confirmClear, setConfirmClear] = useState(false);
  const [controlNote, setControlNote] = useState<string | null>(null);
  const [savingSafety, setSavingSafety] = useState(false);
  const refreshUsage = useDeviceManualRefreshUsage();

  return (
    <div className="ops-card">
      <div className="ops-card__title">App controls</div>
      <p className="ops-card__sub">
        Global — applies to every user instantly. Only the operator can change these.
      </p>

      {/* ── Data mode ── */}
      <div className="ctrl-section">
        <div className="ctrl-section__label">Data mode</div>
        <div className="control-row">
          <div>
            <div className="control-row__label">
              {sampleDataMode ? "Sample" : "Live"}
            </div>
            <div className="control-row__hint">
              {sampleDataMode
                ? "No API spend, demo universe."
                : "Real prices and API calls active."}
            </div>
          </div>
          <Switch
            checked={!sampleDataMode}
            label={sampleDataMode ? "Switch to Live" : "Switch to Sample"}
            disabled={savingSafety}
            onChange={async (goLive) => {
              setSavingSafety(true);
              setControlNote(null);
              if (!goLive) {
                abortLiveDataRequests();
                updateApiControls({ paused: true }, email);
                setSampleDataModeEnabled(true, email);
              }
              const saved = await saveOperatorSafetyPreference({
                sampleDataMode: !goLive,
                apiPaused: !goLive,
              });
              if (!saved && goLive) {
                setSavingSafety(false);
                setControlNote("Authorization failed — no change applied.");
                return;
              }
              window.location.reload();
            }}
          />
        </div>
      </div>

      {/* ── Budget enforcement ── */}
      <div className="ctrl-section">
        <div className="ctrl-section__label">Budget enforcement</div>
        <div className="control-row">
          <div>
            <div className="control-row__label">Enforce daily caps</div>
            <div className="control-row__hint">
              Block a vendor that reaches its fixed free-tier daily limit (not just flag it).
            </div>
          </div>
          <Switch
            checked={controls.enforceBudgets}
            label="Enforce daily budgets"
            onChange={(next) => {
              const saved = updateApiControls({ enforceBudgets: next }, email);
              setControlNote(saved ? null : "Authorization failed — no change applied.");
            }}
          />
        </div>
      </div>

      {/* Live calls-vs-limit per key/vendor is shown read-only in the "Data-source health" board below
   (ApiQuotaBoard). */}

      {/* ── Score display dials ── */}
      <ScoreSpreadSection email={email} />

      {/* ── Engine + maintenance ── */}
      <div className="ctrl-section">
        <div className="ctrl-section__label">Engine &amp; maintenance</div>
        <div className="control-row">
          <div>
            <div className="control-row__label">Full market scan</div>
            <div className="control-row__hint">Scores the whole US universe and publishes signals.</div>
          </div>
          <button
            className="btn btn--primary btn--sm"
            disabled={running || !researchAllowed}
            onClick={() => runResearchNow("manual")}
          >
            {running ? <span className="spinner" /> : <IconRefresh size={14} />}
            {running ? "Running…" : "Run now"}
          </button>
        </div>
        <div className="control-row">
          <div>
            <div className="control-row__label">Usage ledger</div>
            <div className="control-row__hint">Wipe this device's call log. Budgets survive.</div>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => setConfirmClear(true)}>
            Clear
          </button>
        </div>
        <div className="control-row">
          <div>
            <div className="control-row__label">Manual refresh</div>
            <div className="control-row__hint">
              <span className="mono">{refreshUsage.used}</span>
              {"/"}
              <span className="mono">{refreshUsage.limit}</span> used today on this device.
            </div>
          </div>
          <button
            className="btn btn--ghost btn--sm"
            disabled={refreshUsage.used === 0}
            onClick={() => {
              resetManualRefreshCount();
              setControlNote(null);
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {controlNote && (
        <p className="form-feedback form-feedback--error" role="alert">
          {controlNote}
        </p>
      )}

      <p className="text-faint" style={{ fontSize: "var(--type-xs)", lineHeight: 1.5, marginTop: "var(--sp-3)" }}>
        Lock: <span className="mono">{email}</span>
        {controls.updatedBy && controls.updatedAt
          ? ` · controls saved ${relativeTime(controls.updatedAt)}`
          : ""}
        {sampleState.updatedBy && sampleState.updatedAt
          ? ` · mode saved ${relativeTime(sampleState.updatedAt)}`
          : ""}
      </p>

      {confirmClear && (
        <Modal
          title="Clear the usage ledger?"
          onClose={() => setConfirmClear(false)}
          footer={
            <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirmClear(false)}>
                Keep it
              </button>
              <button
                className="btn btn--primary btn--sm"
                onClick={() => {
                  if (clearApiUsage(email)) {
                    setConfirmClear(false);
                  } else {
                    setControlNote("Authorization failed — ledger not cleared.");
                  }
                }}
              >
                Clear ledger
              </button>
            </div>
          }
        >
          <p className="text-muted" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            Erases this device's API call log (gauges reset to zero). Signals, portfolios, and cloud data are untouched.
          </p>
        </Modal>
      )}
    </div>
  );
}

// ── Directory (who's using it) ────────────────────────────────────────────────

function DirectoryCard({ selfId }: { selfId: string }) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = still connecting; [] = connected, nobody online; false = unavailable
  const [online, setOnline] = useState<OnlineUser[] | null | false>(null);
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setError(null);
    setProfiles(null);
    listProfiles(NIL_UUID)
      .then((p) => {
        if (loadSeq.current === seq) setProfiles(p);
      })
      .catch((e: unknown) => {
        if (loadSeq.current === seq) {
          setError(e instanceof Error ? e.message : "Couldn't load the member directory.");
        }
      });
  }, []);

  useEffect(load, [load]);

  useEffect(
    () => observeOnline((users) => setOnline(users === null ? false : users)),
    [],
  );

  const onlineIds = new Set(online === null || online === false ? [] : online.map((u) => u.userId));

  return (
    <div className="ops-card">
      <div className="ops-card__title">Who&apos;s using it</div>
      <p className="ops-card__sub">Registered profiles with live presence.</p>

      {online === false && (
        <div className="ops-banner" role="status">
          Live presence is unavailable right now (Realtime connection failed) — the directory below
          still works.
        </div>
      )}

      {error && (
        <div className="ops-banner ops-banner--error" role="alert">
          <span>{error}</span>
          <button className="btn btn--ghost btn--sm" onClick={load} style={{ marginLeft: "auto" }}>
            Retry
          </button>
        </div>
      )}

      {!error && profiles === null && (
        <div className="dir-section" aria-busy="true" aria-label="Loading members">
          <LoadingNote label="members" hint="Reading the member directory — a moment, not stuck." />
          {[0, 1, 2].map((i) => (
            <div className="dir-row" key={i}>
              <Skeleton width={32} height={32} radius="50%" />
              <div className="col gap-1">
                <Skeleton width={140} height={12} />
                <Skeleton width={90} height={10} />
              </div>
            </div>
          ))}
        </div>
      )}

      {!error && profiles !== null && profiles.length === 0 && (
        <div className="empty">
          <h3>No registered members yet</h3>
          <p>Profiles appear here as soon as someone signs up and picks a handle.</p>
        </div>
      )}

      {!error && profiles !== null && profiles.length > 0 && (
        <div className="dir-section">
          {profiles.map((p) => {
            const name = p.displayName || p.handle || "Member";
            const isOnline = onlineIds.has(p.id);
            return (
              <div className="dir-row" key={p.id}>
                <span
                  className="avatar avatar--sm"
                  style={{ background: p.avatarAccent }}
                  aria-hidden="true"
                >
                  {initialsFromLabel(name)}
                </span>
                <div>
                  <span className="dir-row__name">
                    {name}
                    {p.id === selfId && <span className="you-pill">YOU</span>}
                  </span>
                  {p.handle && <div className="dir-row__handle">@{p.handle}</div>}
                </div>
                {isOnline ? (
                  <span className="online-badge">
                    <span className="online-badge__dot" aria-hidden="true" />
                    Online
                  </span>
                ) : (
                  <span
                    className="text-faint"
                    style={{ marginLeft: "auto", fontSize: "var(--type-xs)" }}
                  >
                    {/* Unknown presence must not read as a definitive "Offline". */}
                    {online === null ? "Checking…" : online === false ? "—" : "Offline"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Console ───────────────────────────────────────────────────────────────────

function AdminConsole({ selfId, email }: { selfId: string; email: string }) {
  const snapshot = useApiUsage();
  const lastRun = useAppStore((s) => s.lastRun);
  const [onlineCount, setOnlineCount] = useState<number | null>(null);
  const sampleDataMode = useSampleDataModeState().enabled;
  const displayedQuality = sampleDataMode ? "paused" : snapshot.quality;

  useEffect(
    () => observeOnline((users) => setOnlineCount(users === null ? null : users.length)),
    [],
  );

  return (
    <>
      <PageHeader
        title="Operator Console"
        description={`Signed in as ${email}`}
      />

      {/* ── Overview strip ── */}
      <div className="stat-grid admin-overview" style={{ marginBottom: "var(--sp-6)" }}>
        <div className="stat">
          <div className="stat__label">Online now</div>
          <div className="stat__value mono">{onlineCount ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="stat__label">API calls today</div>
          <div className="stat__value mono">{snapshot.totalToday}</div>
        </div>
        <div className="stat">
          <div className="stat__label">Data quality</div>
          <div className="stat__value">{QUALITY_COPY[displayedQuality].label}</div>
        </div>
        <div className="stat">
          <div className="stat__label">Last scan</div>
          <div className="stat__value">
            {lastRun?.finishedAt ? relativeTime(lastRun.finishedAt) : "—"}
          </div>
        </div>
      </div>

      {/* ── Main columns ── */}
      <div className="desk-grid">
        <div className="col gap-4">
          <ControlsCard snapshot={snapshot} email={email} />
          <DirectoryCard selfId={selfId} />
        </div>
        <div className="col gap-4">
          <ModelRegistryCard />
          <div className="ops-card">
            <div className="ops-card__title">Engine activity · this device</div>
            <UsagePanel />
          </div>
          <div className="ops-card">
            <div className="ops-card__title">Track Record</div>
            <p className="ops-card__sub">Do higher scores predict better returns?</p>
            <Link to="/performance" className="btn btn--ghost btn--sm" style={{ marginTop: "var(--sp-3)" }}>
              <IconTarget size={14} />
              Open performance ledger
            </Link>
          </div>
        </div>
      </div>

      {/* ── API key pool dashboard ── */}
      <div style={{ marginTop: "var(--sp-5)" }}>
        <ApiQuotaBoard title="API key pools &amp; usage" />
      </div>

      {/* ── Build stamp ── ground-truth "which deploy is live" check. If this id
          doesn't change after a deploy, the browser/PWA is serving a stale cache. */}
      <div className="ops-build-stamp mono" style={{ marginTop: "var(--sp-5)", opacity: 0.6, fontSize: "var(--fs-xs)" }}>
        build {__BUILD_ID__}
      </div>
    </>
  );
}

// ── Page (gate) ───────────────────────────────────────────────────────────────

export function Admin() {
  const configured = useAuthStore((s) => s.configured);
  const ready = useAuthStore((s) => s.ready);
  const userId = useAuthStore((s) => s.userId);
  const email = useAuthStore((s) => s.email);
  const [showSignIn, setShowSignIn] = useState(false);

  if (!configured) {
    return (
      <GateCard title="Operator sign-in needs Supabase">
        <p>
          The console is gated behind your account, and accounts live in Supabase. Add the keys to{" "}
          <span className="mono">.env</span> and restart:
        </p>
        <span className="env-hint">
          {"VITE_SUPABASE_URL=…\nVITE_SUPABASE_ANON_KEY=…\nVITE_ADMIN_EMAILS=you@example.com"}
        </span>
      </GateCard>
    );
  }

  if (!ready) {
    return <Loader text="Checking operator access…" />;
  }

  if (!userId) {
    return (
      <GateCard title="Sign in to the Operator Console">
        <p>Sign in with the operator account to open app controls, usage limits, and the member directory.</p>
        <button className="btn btn--primary" onClick={() => setShowSignIn(true)}>
          Sign in
        </button>
        {showSignIn && <SignInModal onClose={() => setShowSignIn(false)} />}
      </GateCard>
    );
  }

  if (!isAdminEmail(email)) {
    return (
      <GateCard title="Operator-only area">
        <p>
          You&apos;re signed in as <span className="mono">{email}</span>, which isn&apos;t on the
          operator list. Everything else in the app is yours — this room is just for the person
          holding the keys.
        </p>
        {!isAdminConfigured() && (
          <>
            <p>
              No operator is configured yet. To claim the console, add your sign-in email to{" "}
              <span className="mono">.env</span> and restart:
            </p>
            <span className="env-hint">{"VITE_ADMIN_EMAILS=you@example.com"}</span>
          </>
        )}
      </GateCard>
    );
  }

  return <AdminConsole selfId={userId} email={email ?? ""} />;
}
