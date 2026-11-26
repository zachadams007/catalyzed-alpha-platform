/**
 * Operator (admin) gating. Admins are identified by their Supabase sign-in
 * email matching `VITE_ADMIN_EMAILS` - a comma-separated allowlist in .env.
 * No emails are hardcoded and nothing here grants server-side power: Supabase
 * RLS still rules the backend; this only unlocks the in-app Operator console.
 */

function adminEmails(): string[] {
  const raw = import.meta.env.VITE_ADMIN_EMAILS as string | undefined;
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True when at least one admin email is configured in .env. */
export function isAdminConfigured(): boolean {
  return adminEmails().length > 0;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}
