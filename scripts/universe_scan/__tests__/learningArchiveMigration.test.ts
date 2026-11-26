import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0027_learning_universe_artifacts.sql"),
  "utf8",
);
const normalized = migration.replace(/\s+/g, " ").toLowerCase();

describe("learning-universe migration boundary", () => {
  it("removes ambient mutation and truncate privileges before least-privilege regrant", () => {
    expect(normalized).toContain(
      "revoke all on table public.learning_universe_artifacts from public, anon, authenticated, service_role;",
    );
    expect(normalized).toContain(
      "grant select, insert on public.learning_universe_artifacts to service_role;",
    );
    expect(normalized).not.toMatch(
      /grant\s+(?:all|update|delete|truncate)[^;]*learning_universe_artifacts[^;]*service_role/,
    );
  });

  it("keeps RLS, insert validation, uniqueness, and update/delete rejection in the DDL", () => {
    expect(normalized).toContain(
      "alter table public.learning_universe_artifacts enable row level security;",
    );
    expect(normalized).toContain("source_run_id text not null unique");
    expect(normalized).toContain("artifact_sha256 text not null unique");
    expect(normalized).toContain("before insert on public.learning_universe_artifacts");
    expect(normalized).toContain("before update or delete on public.learning_universe_artifacts");
    expect(normalized).toContain("learning_universe_artifacts is append-only");
  });
});
