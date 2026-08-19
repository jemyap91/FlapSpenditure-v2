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
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
