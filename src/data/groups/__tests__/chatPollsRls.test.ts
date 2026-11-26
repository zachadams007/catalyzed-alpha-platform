import { describe, it, expect } from "vitest";

/**
 * RLS-INTENT tests for 0009_groups_chat.sql.
 *
 * We can't spin up Postgres here, so instead we assert the *security contract*
 * of the migration statically: that every members-only table is RLS-enabled with
 * the right policy shapes, that privileged writes go ONLY through SECURITY DEFINER
 * RPCs (no direct client INSERT), that those RPCs re-check membership, and that
 * the realtime publication is wired. If a future edit weakens one of these (e.g.
 * adds a raw INSERT policy on group_activity, or drops the membership check in
 * cast_poll_vote), one of these tests fails - a cheap guardrail around the
 * highest-risk part of the feature. Mirrors the RLS discipline in 0008_groups.sql.
 *
 * The migration is loaded as a raw string via Vite's import.meta.glob (no Node
 * fs dependency, so this also typechecks under the app's tsconfig).
 */

const sqlModules = import.meta.glob("../../../../supabase/migrations/0009_groups_chat.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const SQL = Object.values(sqlModules)[0] ?? "";

/** Collapse whitespace so multi-line statements match on a single normalized string. */
const FLAT = SQL.replace(/\s+/g, " ").toLowerCase();

function hasPolicy(name: string): boolean {
  return FLAT.includes(`create policy "${name.toLowerCase()}"`);
}

describe("0009 migration — tables + RLS enablement", () => {
  const tables = [
    "group_messages",
    "group_polls",
    "group_poll_options",
    "group_poll_votes",
    "group_activity",
    "group_reads",
  ];

  it("creates every social-layer table", () => {
    for (const t of tables) {
      expect(FLAT).toContain(`create table if not exists public.${t}`);
    }
  });

  it("enables row-level security on every table", () => {
    for (const t of tables) {
      expect(FLAT).toContain(`alter table public.${t} enable row level security`);
    }
  });
});

describe("0009 migration — members-only read/write", () => {
  it("chat is readable + writable only by members, and authored as self", () => {
    expect(hasPolicy("members read messages")).toBe(true);
    expect(FLAT).toContain(
      'create policy "members read messages" on public.group_messages for select to authenticated using (public.is_group_member(group_id, auth.uid()))',
    );
    expect(FLAT).toContain(
      'create policy "members send messages" on public.group_messages for insert to authenticated with check (public.is_group_member(group_id, auth.uid()) and author = auth.uid())',
    );
  });

  it("messages are immutable — no UPDATE policy on group_messages", () => {
    expect(FLAT).not.toContain("on public.group_messages for update");
  });

  it("activity feed is read-only to clients (no INSERT/UPDATE/DELETE policy)", () => {
    expect(hasPolicy("members read activity")).toBe(true);
    expect(FLAT).not.toContain("on public.group_activity for insert");
    expect(FLAT).not.toContain("on public.group_activity for update");
    expect(FLAT).not.toContain("on public.group_activity for delete");
  });

  it("poll options + votes are read-only to clients (writes go through RPCs)", () => {
    // Options: read only, never a direct client INSERT/UPDATE.
    expect(hasPolicy("members read poll options")).toBe(true);
    expect(FLAT).not.toContain("on public.group_poll_options for insert");
    expect(FLAT).not.toContain("on public.group_poll_options for update");
    // Votes: read + self-retract (delete), but NO direct insert/update policy.
    expect(hasPolicy("members read votes")).toBe(true);
    expect(hasPolicy("voter retracts vote")).toBe(true);
    expect(FLAT).not.toContain("on public.group_poll_votes for insert");
    expect(FLAT).not.toContain("on public.group_poll_votes for update");
  });

  it("each member manages only their own read mark", () => {
    expect(FLAT).toContain(
      'create policy "upsert own reads" on public.group_reads for insert to authenticated with check (user_id = auth.uid() and public.is_group_member(group_id, auth.uid()))',
    );
    expect(FLAT).toContain(
      'create policy "update own reads" on public.group_reads for update to authenticated using (user_id = auth.uid())',
    );
  });
});

describe("0009 migration — privileged RPCs", () => {
  const definers = ["create_poll", "cast_poll_vote", "close_poll", "mark_group_read"];

  it("are all SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of definers) {
      const re = new RegExp(
        `create or replace function public\\.${fn}\\b[\\s\\S]*?security definer set search_path = public`,
        "i",
      );
      expect(re.test(SQL)).toBe(true);
    }
  });

  it("re-check group membership inside the function body", () => {
    // create_poll and cast_poll_vote must verify the caller is a member.
    expect(SQL).toMatch(/create_poll[\s\S]*?is_group_member\(p_group, v_uid\)/i);
    expect(SQL).toMatch(/cast_poll_vote[\s\S]*?is_group_member\(v_poll\.group_id, v_uid\)/i);
  });

  it("cast_poll_vote refuses votes on a closed/expired poll", () => {
    expect(SQL).toMatch(/v_poll\.closed or \(v_poll\.closes_at is not null and v_poll\.closes_at < now\(\)\)/i);
  });

  it("cast_poll_vote is one-vote-per-member (insert-or-switch on the unique key)", () => {
    expect(FLAT).toContain("constraint group_poll_votes_unique unique (poll_id, voter)");
    expect(FLAT).toContain("on conflict (poll_id, voter) do update set option_id = excluded.option_id");
  });

  it("close_poll is restricted to the opener or an admin", () => {
    expect(SQL).toMatch(/close_poll[\s\S]*?v_poll\.author = v_uid or public\.is_group_admin\(v_poll\.group_id, v_uid\)/i);
  });

  it("grants execute only to authenticated (not anon/public)", () => {
    for (const fn of definers) {
      expect(FLAT).toContain(`revoke all on function public.${fn}`);
      expect(FLAT).toMatch(new RegExp(`grant execute on function public\\.${fn}[^;]*to authenticated`, "i"));
    }
  });
});

describe("0009 migration — activity triggers + realtime", () => {
  it("writes activity via SECURITY DEFINER triggers on the source tables", () => {
    expect(FLAT).toContain("create trigger trg_activity_message after insert on public.group_messages");
    expect(FLAT).toContain("create trigger trg_activity_call after insert on public.group_calls");
    expect(FLAT).toContain("create trigger trg_activity_watchlist after insert on public.group_watchlist");
    expect(FLAT).toContain("create trigger trg_activity_poll_ins after insert on public.group_polls");
    expect(FLAT).toContain("create trigger trg_activity_poll_upd after update on public.group_polls");
  });

  it("only logs poll_closed on the false→true transition", () => {
    expect(SQL).toMatch(/new\.closed and not old\.closed/i);
  });

  it("adds the live tables to the supabase_realtime publication (guarded)", () => {
    for (const t of ["group_messages", "group_poll_votes", "group_polls", "group_activity"]) {
      expect(FLAT).toContain(`alter publication supabase_realtime add table public.${t}`);
    }
  });
});
