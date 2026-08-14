"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import Link from "next/link";
import { signIn, type AuthState } from "@/server/actions/auth";

export function LoginForm({ notice }: { notice?: string }) {
  const [state, action, pending] = useActionState<AuthState, FormData>(
    signIn,
    notice ? { error: notice } : {}
  );
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Move focus to the message whenever it (re)appears — on the initial
  // ?error=auth notice and after a failed submit alike — since a
  // conditionally-mounted role="alert" node doesn't announce reliably
  // across screen-reader/browser pairs, but the mount + focus combination
  // does.
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold">Sign in</h1>
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
            style={{ borderColor: "var(--grid)" }}
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
            autoComplete="current-password"
            aria-describedby={errorId}
            aria-invalid={state.field === "password" ? true : undefined}
            className="rounded-md border px-3 py-2 focus:outline-2 focus:outline-offset-2 focus:outline-[var(--cat-1)]"
            style={{ borderColor: "var(--grid)" }}
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
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        No account?{" "}
        <Link href="/signup" className="underline">
          Create one
        </Link>
      </p>
    </main>
  );
}
