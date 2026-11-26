import { defineConfig, configDefaults } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  // Stub the build stamp that vite.config injects via `define`, so any test that
  // imports a module referencing `__BUILD_ID__` doesn't hit a ReferenceError.
  define: { __BUILD_ID__: JSON.stringify("test") },
  test: {
    environment: "node",
    // Exclude nested worktree checkouts under .claude/worktrees/ (each has its own
    // full src/ copy) so they don't get picked up as duplicate test files alongside
    // the real ones when running `npx vitest run` from the repo root.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
  resolve: { alias: { "@": resolve(__dirname, "src") } },
});
