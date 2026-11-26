/**
 * Invite-link helpers. The app uses HashRouter, so an invite is a deep link to
 * `…/#/groups?join=<token>`: paste it into a group chat and everyone taps in.
 * The raw token is also accepted on its own, for hand-copied codes.
 */

const TOKEN_RE = /[a-f0-9]{24,64}/i;

/** Build the shareable invite URL for the current origin. */
export function inviteLink(token: string): string {
  const base =
    typeof window !== "undefined"
      ? window.location.origin + window.location.pathname
      : "https://catalyzed-alpha.vercel.app/";
  return `${base.replace(/index\.html$/, "")}#/groups?join=${token}`;
}

/** Extract a token from a pasted invite link, hash fragment, or raw code. "" if none. */
export function tokenFromInvite(value: string): string {
  const v = value.trim();
  if (!v) return "";
  const joinIdx = v.indexOf("join=");
  if (joinIdx >= 0) {
    const after = v.slice(joinIdx + "join=".length);
    const token = after.split(/[&\s]/)[0] ?? "";
    return TOKEN_RE.test(token) ? token : "";
  }
  // A bare token pasted on its own.
  const m = v.match(new RegExp(`^${TOKEN_RE.source}$`, "i"));
  return m ? v : "";
}
