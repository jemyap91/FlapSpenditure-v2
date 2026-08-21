import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Vitest's default `include` is `**/*.{test,spec}.?(c|m)[jt]s?(x)`,
    // which matches e2e/*.spec.ts too — Vitest would then import the
    // Playwright suite and fail on `@playwright/test`'s own runner, which
    // only works under `playwright test`. Spreading the defaults rather
    // than replacing them keeps node_modules/dist/etc. excluded.
    // `.claude/worktrees/**`: the harness creates agent worktrees INSIDE this
    // repo, so a worktree's own *.test.tsx files match the default include —
    // and their `@/` alias resolves to THIS checkout's src, not the
    // worktree's, so they fail in ways that say nothing about either tree.
    // Observed as 19 phantom failures and a doubled test count (472 vs 236).
    exclude: [...configDefaults.exclude, "e2e/**", "**/.claude/worktrees/**"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
