"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { currentApiSession } from "@/lib/supabase/api-session";
import { displayPrefix, generateApiToken, hashApiToken } from "@/lib/api-token";

export type CreateTokenState = { error?: string; token?: string; name?: string };
export type RevokeTokenResult = { ok: true } | { error: string };

const nameSchema = z.string().trim().min(1, "Give the token a name").max(60, "Keep the name under 60 characters");
const idSchema = z.uuid();

/**
 * A token must never be able to mint or revoke tokens: a leaked one could
 * otherwise make itself permanent. The MCP tools don't expose these actions,
 * so this can't happen today; refusing here keeps it that way if one ever
 * does.
 */
function calledWithToken() {
  return currentApiSession() !== undefined;
}

/**
 * Creates a personal access token and returns its plaintext -- the only time
 * it is ever available. Only the hash is stored (0028_api_tokens.sql).
 * `user_id` is left to the column's `default auth.uid()` and checked again by
 * the api_tokens_owner policy, so there is no caller-supplied owner to trust.
 */
export async function createApiToken(_prev: CreateTokenState, formData: FormData): Promise<CreateTokenState> {
  if (calledWithToken()) return { error: "Tokens can only be managed from the app" };
  const name = nameSchema.safeParse(formData.get("name"));
  if (!name.success) return { error: name.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const token = generateApiToken();
  const { error } = await supabase.from("api_tokens").insert({
    name: name.data,
    token_hash: hashApiToken(token),
    token_prefix: displayPrefix(token),
  });
  if (error) return { error: "Could not create the token. Please try again." };

  revalidatePath("/api-access");
  return { token, name: name.data };
}

export async function revokeApiToken(id: string): Promise<RevokeTokenResult> {
  if (calledWithToken()) return { error: "Tokens can only be managed from the app" };
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { error: "Token not found" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data, error } = await supabase
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", parsed.data)
    .is("revoked_at", null)
    .select("id");
  if (error) return { error: "Could not revoke the token. Please try again." };
  // Zero rows is not an error from PostgREST -- same check archiveCategory makes.
  if (!data || data.length === 0) return { error: "Token not found" };

  revalidatePath("/api-access");
  return { ok: true };
}
