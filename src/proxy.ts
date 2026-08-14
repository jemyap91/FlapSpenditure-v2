import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next.js 16 deprecated and renamed the `middleware.ts` file convention to
// `proxy.ts` (function renamed `middleware` -> `proxy`); functionality is
// unchanged. See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
export const proxy = (request: NextRequest) => updateSession(request);

export const config = {
  matcher: [
    // Exclude Next.js internals, image assets (including fonts), and the
    // fixed metadata-route URLs, so auth logic never blocks CSS/JS/images
    // from loading or shadows a route that must stay reachable when logged
    // out (robots.txt, sitemap.xml, the PWA manifest, the default favicon,
    // and file-convention OG/Twitter images).
    //
    // The metadata-route literals are `$`-anchored (unlike the `_next/...`
    // prefixes, which must stay unanchored to exclude everything under
    // those directories). Without the `$`, each alternative only has to
    // match a *prefix* of the remaining path inside the negative lookahead,
    // so e.g. `/robots.txt-admin` would satisfy the `robots\.txt` branch,
    // fall outside the matcher, and skip the auth gate entirely — the same
    // fail-open bug class as the `isPublicPath` prefix check fixed in
    // src/lib/supabase/public-paths.ts. These routes are all fixed,
    // extension-free (or fixed-extension, for favicon.ico) top-level names,
    // so anchoring can't accidentally exclude a legitimate nested route.
    "/((?!_next/static|_next/image|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|manifest\\.webmanifest$|opengraph-image$|twitter-image$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|eot)$).*)",
  ],
};
