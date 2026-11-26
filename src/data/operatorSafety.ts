import { isAdminEmail } from "@/lib/admin";
import { applyApiSafetyState, getApiControls } from "@/lib/apiUsage";
import {
  applySampleDataModeState,
  getSampleDataModeState,
} from "@/data/providers/sampleDataMode";
import { supabase } from "@/data/supabase/client";
import { useAuthStore } from "@/store/useAuthStore";
import {
  initGlobalControls,
  isGlobalControlsConfigured,
  saveGlobalControls,
} from "@/data/globalControls";

const USER_METADATA_KEY = "catalyzed_alpha_operator_safety";
const ACCOUNT_SAFETY_VERSION = 1;

interface AccountSafetyState {
  version: number;
  sampleDataMode: boolean;
  apiPaused: boolean;
  updatedAt: string;
}

export interface OperatorSafetyPatch {
  sampleDataMode?: boolean;
  apiPaused?: boolean;
}

function timestampOf(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function currentOperator(): { email: string; userId: string } | null {
  const auth = useAuthStore.getState();
  const email = auth.email?.trim().toLowerCase();
  if (!auth.ready || !auth.userId || !email || !isAdminEmail(email)) return null;
  return { email, userId: auth.userId };
}

function localSafetyState(): AccountSafetyState {
  const sample = getSampleDataModeState();
  const api = getApiControls();
  const updatedAt =
    timestampOf(sample.updatedAt) >= timestampOf(api.updatedAt)
      ? sample.updatedAt
      : api.updatedAt;
  return {
    version: ACCOUNT_SAFETY_VERSION,
    sampleDataMode: sample.enabled,
    apiPaused: sample.enabled ? true : api.paused,
    updatedAt: updatedAt ?? new Date(0).toISOString(),
  };
}

function parseRemote(value: unknown): AccountSafetyState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AccountSafetyState>;
  if (
    candidate.version !== ACCOUNT_SAFETY_VERSION ||
    typeof candidate.sampleDataMode !== "boolean" ||
    typeof candidate.apiPaused !== "boolean" ||
    typeof candidate.updatedAt !== "string" ||
    timestampOf(candidate.updatedAt) === 0
  ) {
    return null;
  }
  return {
    version: ACCOUNT_SAFETY_VERSION,
    sampleDataMode: candidate.sampleDataMode,
    apiPaused: candidate.sampleDataMode ? true : candidate.apiPaused,
    updatedAt: candidate.updatedAt,
  };
}

function applyLocal(state: AccountSafetyState, email: string): boolean {
  const sampleSaved = applySampleDataModeState(
    state.sampleDataMode,
    email,
    state.updatedAt,
  );
  const apiSaved = applyApiSafetyState(
    state.sampleDataMode ? true : state.apiPaused,
    email,
    state.updatedAt,
  );
  return sampleSaved && apiSaved;
}

async function writeRemote(state: AccountSafetyState): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.auth.updateUser({
    data: { [USER_METADATA_KEY]: state },
  });
  return !error;
}

/**
 * Reconcile browser/Tauri storage with the signed-in operator account before
 * research bootstrap. The newest explicit preference wins; missing metadata is
 * seeded from the local fail-closed state.
 */
export async function syncOperatorSafetyFromAccount(): Promise<{ changed: boolean }> {
  // GLOBAL controls are the source of truth for the whole app when Supabase is
  // configured. The boot path already loads them (App.tsx → initGlobalControls);
  // ensure they're loaded here too so any caller is fail-closed, and skip the
  // legacy per-operator user_metadata sync entirely.
  if (isGlobalControlsConfigured()) {
    await initGlobalControls();
    return { changed: false };
  }

  const operator = currentOperator();
  if (!operator || !supabase) return { changed: false };

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user || data.user.id !== operator.userId) {
    return { changed: false };
  }

  const local = localSafetyState();
  const remote = parseRemote(data.user.user_metadata?.[USER_METADATA_KEY]);

  if (!remote || timestampOf(local.updatedAt) > timestampOf(remote.updatedAt)) {
    const seeded: AccountSafetyState = {
      ...local,
      updatedAt:
        timestampOf(local.updatedAt) > 0 ? local.updatedAt : new Date().toISOString(),
    };
    if (await writeRemote(seeded)) {
      applyLocal(seeded, operator.email);
    }
    return { changed: false };
  }

  const changed =
    remote.sampleDataMode !== local.sampleDataMode ||
    remote.apiPaused !== local.apiPaused;
  applyLocal(remote, operator.email);
  return { changed };
}

/**
 * Save an operator-authored safety preference to the account and this local
 * context. Live access is never enabled locally unless the account write wins.
 */
export async function saveOperatorSafetyPreference(
  patch: OperatorSafetyPatch,
): Promise<boolean> {
  // Write to the GLOBAL controls row so the operator's sample/pause choice
  // governs the ENTIRE app for ALL users - not just the operator's own devices.
  if (isGlobalControlsConfigured()) {
    return saveGlobalControls({
      sampleMode: patch.sampleDataMode,
      livePaused: patch.apiPaused,
    });
  }

  const operator = currentOperator();
  if (!operator || !supabase) return false;

  const current = localSafetyState();
  const next: AccountSafetyState = {
    version: ACCOUNT_SAFETY_VERSION,
    sampleDataMode: patch.sampleDataMode ?? current.sampleDataMode,
    apiPaused: patch.apiPaused ?? current.apiPaused,
    updatedAt: new Date().toISOString(),
  };
  if (next.sampleDataMode) next.apiPaused = true;

  if (!(await writeRemote(next))) return false;
  return applyLocal(next, operator.email);
}
