"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import Link from "next/link";
import { signUp, type AuthState } from "@/server/actions/auth";
import { GoogleButton } from "@/components/GoogleButton";

export default function SignupPage() {
  const [state, action, pending] = useActionState<AuthState, FormData>(signUp, {});
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Move focus to the message after a failed submit — a conditionally-
  // mounted role="alert" node doesn't announce reliably across screen-
  // reader/browser pairs, but the mount + focus combination does.
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold">Create account</h1>
      <form action={action} className="flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>
            Email
          </span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            aria-describedby={errorId}
            aria-invalid={state.field === "email" ? true : undefined}
            className="rounded-md border px-3 py-2 focus:outline-2 focus:outline-offset-2 focus:outline-[var(--cat-1)]"
            style={{ borderColor: "var(--ink-2)" }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>
            Password
          </span>
          <input
            name="password"
            type="password"
            required
            autoComplete="new-password"
            aria-describedby={errorId}
            aria-invalid={state.field === "password" ? true : undefined}
            className="rounded-md border px-3 py-2 focus:outline-2 focus:outline-offset-2 focus:outline-[var(--cat-1)]"
            style={{ borderColor: "var(--ink-2)" }}
          />
        </label>
        {/* Always mounted (not conditionally rendered) so assistive tech
            reliably announces the text change instead of missing a node
            that appears and gets its content at the same instant. Empty
            when there's nothing to say. */}
        <p ref={errorRef} id={errorId} role="alert" tabIndex={-1} style={{ color: "var(--neg)" }}>
          {state.error}
        </p>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md px-4 py-2 font-medium focus:outline-2 focus:outline-offset-2 focus:outline-[var(--cat-1)] disabled:opacity-60"
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>

      {/* A labelled separator, not a bare rule: the two blocks above and
          below are alternative ways to do the same thing, and "or" is what
          says so. aria-hidden on the rules leaves just the word in the
          accessibility tree. */}
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1" style={{ background: "var(--grid)" }} />
        {/* `--ink-2`, not `--muted`: measured 3.41:1 against `--page` in
            light mode, under WCAG AA's 4.5:1 for normal text (axe caught
            it). `--ink-2` is 7.53:1 light / 10.85:1 dark. `--muted` is a
            de-emphasis token for non-text chrome, not a text colour at
            this size. */}
        <span className="text-xs uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>
          or
        </span>
        <span aria-hidden className="h-px flex-1" style={{ background: "var(--grid)" }} />
      </div>
      <GoogleButton />
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
