import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_GATE_MATCHER } from "./auth-gate-matcher";

/**
 * Pulls the matcher's *source-code* string literal (backslashes still
 * doubled, as written) out of a file's raw text — deliberately not the
 * evaluated runtime string, so this can compare proxy.ts's copy against
 * this module's copy byte-for-byte as written, without either side's
 * escaping being unescaped first (which is what made a naive
 * `.toContain(AUTH_GATE_MATCHER)` against raw source text fail: the
 * evaluated constant has single backslashes, the source text has doubled
 * ones).
 */
function extractMatcherLiteral(source: string): string {
  const match = /"(\/\(\(\?!_next\/static[^"]+)"/.exec(source);
  if (!match?.[1]) throw new Error("could not find the auth-gate matcher literal in source");
  return match[1];
}

describe("proxy.ts matcher stays in sync with AUTH_GATE_MATCHER", () => {
  it("embeds the exact same literal (Next requires a literal there, not an import — see proxy.ts)", () => {
    // vitest.config.ts runs tests from the project root, so this resolves
    // the same way `npm test`/`npm run test:watch` are invoked.
    const proxySource = readFileSync(resolve(process.cwd(), "src/proxy.ts"), "utf8");
    const matcherModuleSource = readFileSync(
      resolve(process.cwd(), "src/lib/supabase/auth-gate-matcher.ts"),
      "utf8"
    );
    expect(extractMatcherLiteral(proxySource)).toBe(extractMatcherLiteral(matcherModuleSource));
  });

  it("sanity check: the extracted literal really is AUTH_GATE_MATCHER, once unescaped", () => {
    const matcherModuleSource = readFileSync(
      resolve(process.cwd(), "src/lib/supabase/auth-gate-matcher.ts"),
      "utf8"
    );
    // The only escape sequence this pattern ever uses is `\\.` (a JS source
    // double-backslash), which is coincidentally also valid JSON string
    // escaping (`\\` -> a literal backslash), so JSON.parse safely
    // unescapes it the same way the JS engine would — without resorting to
    // an actual code-eval mechanism for a plain string literal.
    const unescaped: unknown = JSON.parse(`"${extractMatcherLiteral(matcherModuleSource)}"`);
    expect(unescaped).toBe(AUTH_GATE_MATCHER);
  });
});

/**
 * AUTH_GATE_MATCHER is Next.js's custom-regex matcher syntax (see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md,
 * "Matcher": "the matcher option supports complex path specifications
 * using regular expressions" via a `/(...)` source). Next compiles that
 * source into a path regex anchored to the full pathname, so `^...$`
 * reproduces the same anchoring here for a direct unit test — the same
 * approach used to hand-verify this pattern during the Task 13 review
 * before this file existed.
 */
const matcher = new RegExp(`^${AUTH_GATE_MATCHER}$`);

// true  = the pattern matches, so Next runs the proxy (and its auth check)
//         against this path.
// false = excluded from the matcher; the proxy never runs for this path.
describe("AUTH_GATE_MATCHER", () => {
  it.each([
    "/",
    "/login",
    "/dashboard",
    // Dotted app routes must not be swallowed by the extension-exclusion
    // branch (only a fixed list of extensions is excluded, and none match
    // ".10").
    "/dashboard/2024.10",
    // Regression: prefix-match bypass of the same bug class as
    // isPublicPath's original bug — must stay gated, not excluded.
    "/robots.txt-admin",
    "/sitemap.xml-evil",
    "/manifest.webmanifest-evil",
    "/opengraph-image-evil",
    "/twitter-image-evil",
    "/favicon.ico-admin",
    // Not favicon.ico — a different filename must not ride along with the
    // favicon.ico exclusion.
    "/favicon.icon",
    // A metadata-shaped name nested under a real route segment is not one
    // of the fixed top-level metadata routes this matcher excludes (the
    // lookahead only ever tests the first path segment).
    "/blog/opengraph-image",
  ])("gates %s", (path) => {
    expect(matcher.test(path)).toBe(true);
  });

  it.each([
    "/_next/static/chunk.js",
    "/_next/image",
    "/favicon.ico",
    "/robots.txt",
    "/sitemap.xml",
    "/manifest.webmanifest",
    "/opengraph-image",
    "/twitter-image",
    "/logo.png",
    "/fonts/geist.woff2",
  ])("excludes %s", (path) => {
    expect(matcher.test(path)).toBe(false);
  });
});
