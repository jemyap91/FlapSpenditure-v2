"use client";

import { useActionState, useId } from "react";
import Link from "next/link";
import { signUp, type AuthState } from "@/server/actions/auth";

export default function SignupPage() {
  const [state, action, pending] = useActionState<AuthState, FormData>(signUp, {});
  const errorId = useId();

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
            aria-describedby={state.error ? errorId : undefined}
            aria-invalid={state.error ? true : undefined}
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
            autoComplete="new-password"
            aria-describedby={state.error ? errorId : undefined}
            aria-invalid={state.error ? true : undefined}
            className="rounded-md border px-3 py-2 focus:outline-2 focus:outline-offset-2 focus:outline-[var(--cat-1)]"
            style={{ borderColor: "var(--grid)" }}
          />
        </label>
        {state.error && (
          <p id={errorId} role="alert" style={{ color: "var(--neg)" }}>
            {state.error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md px-4 py-2 font-medium focus:outline-2 focus:outline-offset-2 focus:outline-[var(--cat-1)] disabled:opacity-60"
          style={{ background: "var(--cat-1)", color: "#fff" }}
        >
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
