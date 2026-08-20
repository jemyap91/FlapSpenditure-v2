"use client";

import { useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * "Continue with Google" for /login and /signup. One component for both:
 * OAuth makes no distinction between signing in and signing up — the same
 * call creates the account if it does not exist and signs into it if it
 * does — so two variants would be two names for identical behaviour.
 *
 * A Client Component, unlike this app's email/password flow (which runs
 * through Server Actions). It has to be: `signInWithOAuth` works by
 * navigating the browser to Google, so it needs `window`. That is also why
 * this is the one auth path that does not go through `src/server/actions/
 * auth.ts` — there is no credential here for a server to receive.
 *
 * Nothing else needs changing for this to work end to end: `/auth/callback`
 * (src/app/auth/callback/route.ts) already exchanges the returned code for
 * a session, `/auth` is already in PUBLIC_PATHS so the auth gate lets the
 * callback through, and a first-time Google user gets a profile and the 16
 * default categories from the same `on auth.users` trigger an email signup
 * fires, then lands on /onboarding via the (app) layout's wallet-count gate.
 *
 * Requires the Google provider to be enabled in the Supabase dashboard with
 * a Google Cloud OAuth client whose authorized redirect URI is
 * `https://<project-ref>.supabase.co/auth/v1/callback` — Supabase's own
 * callback, not this app's. Until then `signInWithOAuth` returns an error,
 * which is what the alert below reports.
 */
export function GoogleButton() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start() {
    setError(null);
    setPending(true);

    const supabase = createBrowserClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      // Read from the live origin rather than an env var or a constant: one
      // build serves localhost, Vercel preview URLs and production alike,
      // and any fixed value would send two of those three to the wrong host.
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

    if (oauthError) {
      // Deliberately not `oauthError.message`: the provider's own text
      // ("Unsupported provider: provider is not enabled") describes this
      // project's configuration, not anything the person reading it can act
      // on, and this codebase never forwards raw provider strings to the
      // client (see src/lib/validation/auth.ts).
      setError("Could not start Google sign-in. Please try again.");
      // Re-enable so a retry is possible. On the success path the browser
      // is already navigating to Google, so leaving it disabled there is
      // correct — there is nothing left to click.
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Always mounted rather than conditionally rendered, the same
          convention every other form in this codebase documents: a
          role="alert" that appears and receives its text in the same
          instant is not reliably announced. Empty when there is nothing
          to say. */}
      <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
        {error}
      </p>
      <button
        type="button"
        onClick={start}
        disabled={pending}
        className={`rounded-md border px-4 py-2 font-medium disabled:opacity-60 ${FOCUS_RING}`}
        style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}
      >
        {/* Google's mark, inlined rather than fetched: a remote image would
            be a third-party request on the sign-in page and would break the
            button's label if it failed to load. aria-hidden because the
            button's own text already names the provider. */}
        <span className="flex items-center justify-center gap-2">
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden focusable="false">
            <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.1z" />
            <path fill="#34A853" d="M24 46c6 0 11-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8 41.1 15.4 46 24 46z" />
            <path fill="#FBBC05" d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2v-5.7H4.5C2.9 17.3 2 20.5 2 24s.9 6.7 2.5 9.9l7.3-5.7z" />
            <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.4 2 8 6.9 4.5 14.1l7.3 5.7c1.7-5.2 6.5-9 12.2-9z" />
          </svg>
          Continue with Google
        </span>
      </button>
    </div>
  );
}
