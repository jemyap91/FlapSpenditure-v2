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
