import { z } from "zod";

/**
 * Shared email/password shape for sign-in and sign-up. Server-side
 * validation only — the browser never talks to Supabase directly, so this
 * schema runs inside the Server Actions in src/server/actions/auth.ts, not
 * in a client-side form library.
 */
export const credentials = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type Credentials = z.infer<typeof credentials>;

/** Which input the UI should mark invalid. Left unset when an error isn't
 * about a specific field (e.g. "wrong password" must never say *which*
 * field is wrong, or it becomes an account-enumeration oracle — see
 * signInErrorMessage below). */
export type AuthField = "email" | "password";

export type AuthFormError = { message: string; field?: AuthField };

/**
 * Turns a failed `credentials.safeParse` into an app-authored message.
 * Only ever returns our own two custom messages (from the schema above) or
 * a generic fallback — never zod's own generated issue text, which for an
 * omitted field reads like "Invalid input: expected string, received
 * undefined" and has no business reaching an end user.
 */
export function credentialsValidationError(error: z.ZodError): AuthFormError {
  const field = error.issues[0]?.path[0];
  if (field === "email") {
    return { message: "Enter a valid email address", field: "email" };
  }
  if (field === "password") {
    return { message: "Password must be at least 8 characters", field: "password" };
  }
  return { message: "Check your email and password and try again." };
}

/**
 * The subset of a Supabase `AuthError` these mappers need. Kept structural
 * (rather than importing `AuthError` from `@supabase/supabase-js`) so this
 * module stays a dependency-free, easily-testable pure function like the
 * rest of src/lib/validation — the same reasoning src/lib/supabase/
 * public-paths.ts documents for staying free of `next/server`.
 */
type ProviderError = { code?: string; status?: number };

/**
 * signIn errors collapse to ONE generic message regardless of the
 * underlying reason. Supabase's own "Invalid login credentials" already
 * hides wrong-password vs. unknown-email; this goes further so a
 * differently-worded provider error can't reopen that gap by accident —
 * e.g. a rate-limit message, or "Email not confirmed" if
 * `enable_confirmations` is ever turned on for this project (that message
 * only appears for an email that HAS an account, which is exactly an
 * enumeration oracle). The one distinction kept is server error (5xx) vs.
 * everything else, since a 5xx says nothing about whether the account
 * exists.
 */
export function signInErrorMessage(error: ProviderError): AuthFormError {
  if (error.status !== undefined && error.status >= 500) {
    return { message: "Something went wrong. Please try again." };
  }
  return { message: "Invalid email or password." };
}

/**
 * signUp errors: a small allowlist of provider error *codes* (stable,
 * unlike message text) that are safe to describe specifically, because
 * they're about the submission just made, not about whether an account
 * exists. Everything else — including `user_already_exists` / `email_exists`,
 * which is exactly the enumeration oracle under this project's
 * `enable_confirmations = false` (autoconfirm returns that error directly
 * instead of the obfuscated response GoTrue gives when confirmations are
 * on) — collapses to the same neutral fallback text, so reading the
 * rendered message alone cannot distinguish "this email is taken" from
 * "the server hiccuped."
 */
export function signUpErrorMessage(error: ProviderError): AuthFormError {
  if (error.code === "weak_password") {
    return { message: "Choose a stronger password.", field: "password" };
  }
  if (error.code === "email_address_invalid") {
    return { message: "Enter a valid email address.", field: "email" };
  }
  return { message: "We couldn't create your account with those details. Please try again." };
}

/**
 * True when a signUp error indicates the email is already registered.
 *
 * The caller (src/server/actions/auth.ts) uses this to respond exactly as
 * it would on a genuine success — same 303 redirect, no error text, no
 * `field` — instead of returning an error response at all. That's what
 * actually closes the enumeration oracle: under this project's
 * `enable_confirmations = false`, GoTrue returns this error *synchronously,
 * with no session*, for an email that already has an account, so even a
 * message-text fix wouldn't be enough on its own — a 200-with-error vs.
 * 303-redirect difference in the response shape would still tell an
 * attacker apart the two cases regardless of what the error text says. No
 * session is fabricated for the "already exists" case (GoTrue returns none
 * to fabricate one from), so this never logs the requester into an account
 * they don't hold the password for — it only makes the *shape* of the
 * response match.
 *
 * Both codes are treated the same: `user_already_exists` is what local
 * GoTrue actually returns for a duplicate `signUp` (verified directly
 * against the running local instance); `email_exists` is a newer/alternate
 * code used elsewhere in the GoTrue API surface. Folding both in is
 * harmless even if one of them never actually fires from this code path.
 */
export function isAccountAlreadyExistsError(error: ProviderError): boolean {
  return error.code === "user_already_exists" || error.code === "email_exists";
}
