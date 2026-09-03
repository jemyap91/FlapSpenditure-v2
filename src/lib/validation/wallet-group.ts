import { z } from "zod";

/**
 * How a user's wallet list is ordered. Stored on `profiles.wallet_sort`
 * (0019_wallet_groups.sql) so the choice follows them between devices.
 *
 * Only `manual` needs anything persisted per wallet — `name` and `created`
 * are derived from columns every member already reads, which is why they
 * cost no storage and cannot get out of step with the wallets themselves.
 */
export const WALLET_SORTS = ["manual", "name", "created"] as const;
export type WalletSort = (typeof WALLET_SORTS)[number];
export const walletSortInput = z.enum(WALLET_SORTS);

/** Matches `wallet_groups`' own CHECK (`length(btrim(name)) between 1 and 40`)
 *  exactly, read from the migration rather than guessed — a mismatch here
 *  reaches the user as a driver error instead of a sentence. */
const groupName = z.string().trim().min(1, "Name is required").max(40, "Name is too long");

export const walletGroupInput = z.object({ name: groupName });
export const walletGroupEditInput = z.object({ id: z.uuid(), name: groupName });

/**
 * Filing one wallet into a group, or out of every group.
 *
 * `group_id: null` is a real, intended value rather than "unset": it is how
 * a wallet leaves a group and returns to the ungrouped list, so the schema
 * requires the key to be present and merely allows its value to be null.
 * An optional field would make a malformed payload that omitted it look
 * identical to a deliberate ungrouping.
 *
 * `user_id` is deliberately absent and is never accepted from a caller — the
 * action derives it from the session. 0019 grants UPDATE on `group_id` and
 * `sort_order` only, so even a direct POST cannot rewrite whose row it is.
 */
export const walletGroupAssignInput = z.object({
  wallet_id: z.uuid(),
  group_id: z.uuid().nullable(),
});

/**
 * A manual ordering, as the complete list of wallet ids in their new order.
 *
 * Whole-list rather than a single {id, position} move: positions are only
 * meaningful relative to each other, and applying a one-row move against a
 * list the server may have seen change (a wallet shared with you since you
 * loaded the page) produces an order neither side intended. Sending the list
 * makes the client's view of it explicit and the write idempotent.
 */
export const walletOrderInput = z.object({
  wallet_ids: z.array(z.uuid()).min(1, "Nothing to reorder").max(200),
});

export type WalletGroupInput = z.infer<typeof walletGroupInput>;
export type WalletGroupEditInput = z.infer<typeof walletGroupEditInput>;
export type WalletGroupAssignInput = z.infer<typeof walletGroupAssignInput>;
export type WalletOrderInput = z.infer<typeof walletOrderInput>;
