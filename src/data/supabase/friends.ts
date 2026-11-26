import { avatarAccentFromLabel } from "@/lib/profileDisplay";
import { supabase } from "./client";

/**
 * Typed data-access for the friends backend. Reads/writes go through Supabase
 * with RLS enforcing who can see what (see supabase/migrations/0001_friends.sql).
 *
 * We resolve related profiles with a second `in(...)` query and join in JS
 * rather than relying on PostgREST embedding - simpler and less brittle.
 */

export interface Profile {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarAccent: string;
}

export interface Friend {
  friendshipId: string;
  profile: Profile;
}

export interface FriendRequest {
  friendshipId: string;
  profile: Profile; // the other person
  createdAt: string;
}

export interface FriendShare {
  id: string;
  author: Profile;
  ticker: string;
  note: string;
  createdAt: string;
}

export interface FriendGraph {
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

interface ProfileRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_accent: string | null;
}

const PROFILE_COLS = "id, handle, display_name, avatar_accent";

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

function toProfile(r: ProfileRow): Profile {
  return {
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatarAccent: r.avatar_accent ?? "#3f5fc9",
  };
}

async function fetchProfiles(ids: string[]): Promise<Map<string, Profile>> {
  const map = new Map<string, Profile>();
  if (ids.length === 0) return map;
  const { data, error } = await client().from("profiles").select(PROFILE_COLS).in("id", ids);
  if (error) throw error;
  for (const r of (data ?? []) as ProfileRow[]) map.set(r.id, toProfile(r));
  return map;
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await client()
    .from("profiles")
    .select(PROFILE_COLS)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? toProfile(data as ProfileRow) : null;
}

export async function upsertProfile(
  userId: string,
  fields: { handle: string; displayName: string },
): Promise<Profile> {
  const cleanHandle = fields.handle.trim().replace(/^@+/, "");
  const displayName = fields.displayName.trim() || cleanHandle;
  const accent = avatarAccentFromLabel(displayName);
  const { data, error } = await client()
    .from("profiles")
    .upsert(
      {
        id: userId,
        handle: cleanHandle,
        display_name: displayName,
        avatar_accent: accent,
      },
      { onConflict: "id" },
    )
    .select(PROFILE_COLS)
    .single();
  if (error) throw error;
  return toProfile(data as ProfileRow);
}

/** @deprecated Use upsertProfile - kept for narrow handle-only updates. */
export async function updateHandle(userId: string, handle: string): Promise<Profile> {
  const existing = await getProfile(userId);
  return upsertProfile(userId, {
    handle,
    displayName: existing?.displayName ?? handle.replace(/^@+/, ""),
  });
}

export async function searchProfiles(query: string, excludeId: string): Promise<Profile[]> {
  const q = query.trim().replace(/^@+/, "");
  if (!q) return [];
  const pattern = `${q}%`;
  const { data, error } = await client()
    .from("profiles")
    .select(PROFILE_COLS)
    .or(`handle.ilike.${pattern},display_name.ilike.${pattern}`)
    .not("id", "eq", excludeId)
    .not("handle", "is", null)
    .limit(10);
  if (error) throw error;
  return ((data ?? []) as ProfileRow[]).map(toProfile);
}

/** Public profile directory for signed-in users. Emails and auth data never leave Supabase Auth. */
export async function listProfiles(excludeId: string): Promise<Profile[]> {
  const pageSize = 500;
  const profiles: Profile[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client()
      .from("profiles")
      .select(PROFILE_COLS)
      .not("id", "eq", excludeId)
      .not("handle", "is", null)
      .not("display_name", "is", null)
      .order("display_name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;

    const rows = (data ?? []) as ProfileRow[];
    profiles.push(...rows.map(toProfile));
    if (rows.length < pageSize) return profiles;
  }
}

interface FriendshipRow {
  id: string;
  requester: string;
  addressee: string;
  status: string;
  created_at: string;
}

export async function getFriendGraph(userId: string): Promise<FriendGraph> {
  const { data, error } = await client()
    .from("friendships")
    .select("id, requester, addressee, status, created_at")
    .or(`requester.eq.${userId},addressee.eq.${userId}`);
  if (error) throw error;
  const rows = (data ?? []) as FriendshipRow[];

  const otherIds = rows.map((r) => (r.requester === userId ? r.addressee : r.requester));
  const profiles = await fetchProfiles([...new Set(otherIds)]);
  const other = (r: FriendshipRow) =>
    profiles.get(r.requester === userId ? r.addressee : r.requester);

  const graph: FriendGraph = { friends: [], incoming: [], outgoing: [] };
  for (const r of rows) {
    const profile = other(r);
    if (!profile) continue;
    if (r.status === "accepted") {
      graph.friends.push({ friendshipId: r.id, profile });
    } else if (r.status === "pending") {
      if (r.addressee === userId) {
        graph.incoming.push({ friendshipId: r.id, profile, createdAt: r.created_at });
      } else {
        graph.outgoing.push({ friendshipId: r.id, profile, createdAt: r.created_at });
      }
    }
  }
  return graph;
}

export async function sendFriendRequest(requester: string, addressee: string): Promise<void> {
  const { error } = await client()
    .from("friendships")
    .insert({ requester, addressee, status: "pending" });
  if (error) throw error;
}

export async function respondToRequest(friendshipId: string, accept: boolean): Promise<void> {
  const c = client();
  if (accept) {
    const { error } = await c
      .from("friendships")
      .update({ status: "accepted", updated_at: new Date().toISOString() })
      .eq("id", friendshipId);
    if (error) throw error;
  } else {
    const { error } = await c.from("friendships").delete().eq("id", friendshipId);
    if (error) throw error;
  }
}

export async function removeFriendship(friendshipId: string): Promise<void> {
  const { error } = await client().from("friendships").delete().eq("id", friendshipId);
  if (error) throw error;
}

interface ShareRow {
  id: string;
  author: string;
  ticker: string;
  note: string;
  created_at: string;
}

/** Friend/public shares visible to the viewer (excludes the viewer's own posts). */
export async function getFriendShares(viewerId: string): Promise<FriendShare[]> {
  const { data, error } = await client()
    .from("shares")
    .select("id, author, ticker, note, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = ((data ?? []) as ShareRow[]).filter((r) => r.author !== viewerId);
  const profiles = await fetchProfiles([...new Set(rows.map((r) => r.author))]);
  return rows
    .map((r): FriendShare | null => {
      const author = profiles.get(r.author);
      return author
        ? { id: r.id, author, ticker: r.ticker, note: r.note, createdAt: r.created_at }
        : null;
    })
    .filter((s): s is FriendShare => s !== null);
}

export async function createShare(author: string, ticker: string, note: string): Promise<void> {
  const { error } = await client().from("shares").insert({
    author,
    ticker: ticker.trim().toUpperCase(),
    note: note.trim(),
    visibility: "friends",
  });
  if (error) throw error;
}
