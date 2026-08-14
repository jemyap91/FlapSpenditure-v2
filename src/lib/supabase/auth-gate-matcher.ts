/**
 * The proxy's (src/proxy.ts) `config.matcher` pattern, extracted to its own
 * module so it can be unit-tested without pulling in `next/server` — same
 * reasoning as public-paths.ts staying free of it. This is the on/off
 * switch for the entire auth gate: a path that fails to match runs the
 * proxy (and therefore updateSession's auth check); a path that matches
 * the negative lookahead's exclusions never does.
 *
 * Excludes Next.js internals, image assets (including fonts), and the
 * fixed metadata-route URLs, so auth logic never blocks CSS/JS/images from
 * loading or shadows a route that must stay reachable when logged out
 * (robots.txt, sitemap.xml, the PWA manifest, the default favicon, and
 * file-convention OG/Twitter images).
 *
 * The metadata-route literals are `$`-anchored (unlike the `_next/...`
 * prefixes, which must stay unanchored to exclude everything under those
 * directories). Without the `$`, each alternative only has to match a
 * *prefix* of the remaining path inside the negative lookahead, so e.g.
 * `/robots.txt-admin` would satisfy the `robots\.txt` branch, fall outside
 * the matcher, and skip the auth gate entirely — the same fail-open bug
 * class as the `isPublicPath` prefix check fixed in
 * src/lib/supabase/public-paths.ts. These routes are all fixed,
 * extension-free (or fixed-extension, for favicon.ico) top-level names, so
 * anchoring can't accidentally exclude a legitimate nested route (e.g.
 * `/blog/opengraph-image` is unaffected — the lookahead only tests the
 * very first path segment).
 *
 * See auth-gate-matcher.test.ts for the committed regression coverage.
 */
export const AUTH_GATE_MATCHER =
  "/((?!_next/static|_next/image|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|manifest\\.webmanifest$|opengraph-image$|twitter-image$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|eot)$).*)";
