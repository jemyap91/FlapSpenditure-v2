"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  credentials,
  credentialsValidationError,
  isAccountAlreadyExistsError,
  signInErrorMessage,
  signUpErrorMessage,
  type AuthField,
  type AuthFormError,
} from "@/lib/validation/auth";

export type AuthState = { error?: string; field?: AuthField };

/** Adapts the `{ message, field }` shape the pure mappers in
 * src/lib/validation/auth.ts return to this module's `{ error, field }`
 * useActionState shape. */
function toAuthState({ message, field }: AuthFormError): AuthState {
  return { error: message, field };
}

/**
 * Server Functions are reachable via direct POST requests, not just through
 * this app's forms (see node_modules/next/dist/docs/01-app/02-guides/data-security.md,
 * "Authentication and authorization"). signIn/signUp/signOut *are* the
 * authentication boundary here, so there is no separate session check to
 * perform before them — but every field is still re-validated server-side
 * with `credentials.safeParse`, since a raw POST can send anything.
 *
 * Error messages returned to the client are never the raw provider/zod
 * text — see src/lib/validation/auth.ts for why (account enumeration via
 * signUp's "already registered" error under this project's
 * enable_confirmations=false, plus zod's own internals leaking through for
 * malformed POSTs).
 */

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return toAuthState(credentialsValidationError(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return toAuthState(signInErrorMessage(error));

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return toAuthState(credentialsValidationError(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp(parsed.data);

  // "Already registered" gets the exact same response as success (redirect,
  // no error text) rather than an error return — see
  // isAccountAlreadyExistsError's doc comment in src/lib/validation/auth.ts
  // for why the response *shape*, not just the message wording, is what
  // closes the account-enumeration oracle here. No session is created or
  // assumed for this branch: GoTrue returns none for a duplicate signUp, so
  // there is nothing to fabricate one from.
  if (error && !isAccountAlreadyExistsError(error)) {
    return toAuthState(signUpErrorMessage(error));
  }

  // A database trigger (see supabase/migrations) seeds a profiles row and
  // 16 default categories for the new auth.users row. Nothing to seed here.
  revalidatePath("/", "layout");
  redirect("/onboarding");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  // Explicit `local` scope: "sign out" here means this device. auth-js
  // defaults to `global`, which revokes refresh tokens on every device the
  // user is signed into — signing out on a laptop would silently log them
  // out on their phone too. A "sign out everywhere" action belongs behind
  // its own explicit control in a later phase, not this button's default.
  //
  // Errors from signOut() (e.g. an already-expired session) still mean the
  // client should end up logged out, so we don't branch on them here — the
  // redirect below always lands on /login either way.
  await supabase.auth.signOut({ scope: "local" });
  revalidatePath("/", "layout");
  redirect("/login");
}
