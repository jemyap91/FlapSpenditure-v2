"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { credentials } from "@/lib/validation/auth";

export type AuthState = { error?: string };

/**
 * Server Functions are reachable via direct POST requests, not just through
 * this app's forms (see node_modules/next/dist/docs/01-app/02-guides/data-security.md,
 * "Authentication and authorization"). signIn/signUp/signOut *are* the
 * authentication boundary here, so there is no separate session check to
 * perform before them — but every field is still re-validated server-side
 * with `credentials.safeParse`, since a raw POST can send anything.
 */

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp(parsed.data);
  if (error) return { error: error.message };

  // A database trigger (see supabase/migrations) seeds a profiles row and
  // 16 default categories for the new auth.users row. Nothing to seed here.
  revalidatePath("/", "layout");
  redirect("/onboarding");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  // Errors from signOut() (e.g. an already-expired session) still mean the
  // client should end up logged out, so we don't branch on them here — the
  // redirect below always lands on /login either way.
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
