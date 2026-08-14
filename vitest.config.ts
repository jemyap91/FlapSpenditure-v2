import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// src/lib/supabase/env.ts throws at import time if
// NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY are missing from
// process.env, and src/lib/supabase/server.ts (imported by every Server
// Action, e.g. src/server/actions/transactions.ts) imports it at module
// scope — so merely importing an action module in a test (to unit-test a
// pure export like `signedAmount`, per this task's brief) throws before a
// single test runs. Next.js loads .env.local into process.env automatically
// for `next dev`/`next build`; Vitest does not do this on its own (Vite's
// own automatic .env loading only populates `import.meta.env`, which this
// project's code never reads). `loadEnv` is Vite's own helper for reading
// the same .env files Next does; assigning its result onto `process.env`
// here — once, before the test config is built — is what lets an action
// test file import its module without every test needing its own mock.
// Both vars are `NEXT_PUBLIC_*` (meant to be public, shipped to the
// browser) so populating them from `.env.local` this way carries the same
// exposure they already have at runtime, not a new one.
Object.assign(process.env, loadEnv("test", process.cwd(), ""));

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", globals: true, setupFiles: ["./vitest.setup.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
