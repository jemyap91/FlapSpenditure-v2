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
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.webmanifest|opengraph-image|twitter-image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|eot)$).*)",
  ],
};
