import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseFetch } from "@/data/supabase/fetch";

/**
 * Single Supabase client for auth + the friends backend.
 *
 * Reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (public anon key only).
 * Uses a Tauri-aware fetch in the desktop shell to avoid "Failed to fetch".
 *
 * Auth: email + password (no email OTP codes). Profiles store display name for
 * avatar initials and handle for friend search.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      global: { fetch: supabaseFetch },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
