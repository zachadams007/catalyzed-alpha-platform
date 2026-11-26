import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useGroupsStore } from "@/store/useGroupsStore";
import { runSocialReconcile } from "@/lib/socialNotify";

/**
 * Fires the bottom-right toast for new social events (friend requests, group
 * invites, shares) - including ones that arrived while the app was CLOSED.
 *
 * The pending state (incoming requests / pendingInvites / shares) is loaded from
 * the server on every sign-in and kept live by the realtime channels, so running
 * the reconcile whenever any of those arrays change covers BOTH cases with one
 * path: a live event (array updates → toast) and an offline backlog (arrays load
 * on reopen → toast). {@link runSocialReconcile} dedupes against a persisted
 * per-user "seen" set, so it never repeats or double-fires with the realtime path.
 */
export function useSocialNotifications(): void {
  const userId = useAuthStore((s) => s.userId);
  const ready = useAuthStore((s) => s.ready);
  const incoming = useAuthStore((s) => s.incoming);
  const shares = useAuthStore((s) => s.shares);
  const friends = useAuthStore((s) => s.friends);
  const invites = useGroupsStore((s) => s.pendingInvites);
  const pushToast = useAppStore((s) => s.pushToast);

  useEffect(() => {
    if (!userId || !ready) return;
    runSocialReconcile(userId, { incoming, invites, shares, friends }, pushToast);
  }, [userId, ready, incoming, invites, shares, friends, pushToast]);
}
