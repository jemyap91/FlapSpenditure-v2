import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { isThemePref, THEME_COOKIE_NAME } from "@/lib/theme-cookie";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ledger",
  description: "A small, fast expense tracker for shared wallets.",
};

/**
 * Sets `data-theme` on `<html>` — not on some inner wrapper — because
 * src/app/globals.css keys its dark-mode palette off `:root[data-theme="dark"]`
 * and `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`.
 * `:root` is a CSS pseudo-class that always refers to the document's root
 * element (`<html>`); it does NOT match a `data-theme` attribute placed on a
 * descendant div. Since it's already read here during the server render,
 * the very first byte of HTML has the right attribute — no client-side
 * effect flips it after hydration, so there is no flash of the wrong theme
 * for an explicit 'light'/'dark' choice.
 *
 * For 'system' the attribute is omitted entirely, so globals.css's
 * `@media (prefers-color-scheme: dark)` block — a browser-native media
 * query, not JS — decides, and keeps deciding live if the OS theme changes
 * while the app is open. No listener needed for that case either.
 *
 * Reads ONLY the `theme` cookie (src/lib/theme-cookie.ts) — deliberately
 * NOT `getCurrentUserProfile()` / `supabase.auth.getUser()`. A prior version
 * of this layout called getUser() here, which is a real GoTrue network
 * round trip; awaiting it before returning anything blocked the first byte
 * of HTML — not just the theme, but <head>, fonts, everything — on every
 * single route, including /login and /signup, which have no reason to wait
 * on auth at all. The proxy (src/proxy.ts) already pays that same getUser()
 * round trip once per request for its own auth gate; this layout paying it
 * again on top, before streaming a byte, was pure latency with nothing to
 * show for it. The `(app)` layout still calls getUser() — there it is
 * load-bearing (the actual auth gate) — and reconciles this cookie against
 * `profiles.theme` when they disagree (see ThemeCookieSync.tsx), so a theme
 * change made on another device still converges, just on the next render
 * rather than this one.
 *
 * `cookies()` is itself a request-time API (see node_modules/next/dist/docs/
 * 01-app/03-api-reference/04-functions/cookies.md, "Good to know"), so this
 * layout still opts the app into dynamic rendering — but a cookie read is a
 * local, synchronous-cost operation, not a network call, so "dynamic" no
 * longer means "blocked on the network" the way the getUser() version did.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const rawTheme = cookieStore.get(THEME_COOKIE_NAME)?.value;
  const theme = isThemePref(rawTheme) ? rawTheme : "system";

  return (
    <html
      lang="en"
      data-theme={theme === "system" ? undefined : theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
