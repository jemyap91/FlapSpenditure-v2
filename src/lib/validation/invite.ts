import { z } from "zod";

/**
 * An invite is a claim about an email ADDRESS, not a user id — the person may
 * not have signed up when it is created. Stored lower-cased and trimmed
 * because `accept_wallet_invite` matches it against the caller's JWT email
 * the same way.
 */
export const inviteInput = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address")),
});

export type InviteInput = z.infer<typeof inviteInput>;
export type InviteField = keyof InviteInput;
