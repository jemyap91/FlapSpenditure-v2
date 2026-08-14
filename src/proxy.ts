import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next.js 16 deprecated and renamed the `middleware.ts` file convention to
// `proxy.ts` (function renamed `middleware` -> `proxy`); functionality is
// unchanged. See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
export const proxy = (request: NextRequest) => updateSession(request);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)"],
};
