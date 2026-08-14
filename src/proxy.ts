import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next.js 16 deprecated and renamed the `middleware.ts` file convention to
// `proxy.ts` (function renamed `middleware` -> `proxy`); functionality is
// unchanged. See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
export const proxy = (request: NextRequest) => updateSession(request);

export const config = {
  matcher: [
    // KEEP IN SYNC with AUTH_GATE_MATCHER in
    // src/lib/supabase/auth-gate-matcher.ts, which documents this pattern
    // (what it excludes and why the metadata-route branches are
    // `$`-anchored) and carries its regression test. It can't just be
    // imported from there: Next statically parses this file's `config`
    // export at build time and rejects anything but a literal string here
    // — `matcher: [AUTH_GATE_MATCHER]` fails the build with "Entry
    // matcher[0] need to be static strings or static objects." The two
    // copies are kept from silently drifting apart by a test in
    // auth-gate-matcher.test.ts that reads this file's source and asserts
    // it contains the same literal.
    "/((?!_next/static|_next/image|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|manifest\\.webmanifest$|opengraph-image$|twitter-image$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|eot)$).*)",
  ],
};
