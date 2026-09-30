"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { refundInput, precisionError, signedAmount } from "@/lib/validation/transaction";
import type { RefundInput } from "@/lib/validation/transaction";
import { parseAmountInput, minorUnitFor } from "@/lib/money";
import { refundErrorMessage } from "@/lib/refund-errors";

/**
 * Records one repayment of one expense — the only way a refund row is
 * created (spec 2026-09-30-refunds-design.md §4.2). Same posture as
 * createTransaction: `input` is re-validated because Server Functions are
 * reachable by direct POST, and the caller comes from the session.
 *
 * Every check here is ALSO enforced in the database (0030's refund_shape,
 * check_refund_parent, the same-space FK). These exist to answer in a
 * sentence instead of a generic failure, and to stop before the write.
 */
export async function createRefund(input: RefundInput): Promise<{ id: string } | { error: string }> {
  const parsed = refundInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { refund_of, wallet_id, amount, occurred_on, note, merchant } = parsed.data;

  // RLS scopes this to expenses in wallets the caller belongs to, so "not
  // visible" and "does not exist" are one answer, as in check_refund_parent.
  const { data: expense } = await supabase
    .from("transactions")
    .select("id, kind, currency_code, space_id")
    .eq("id", refund_of)
    .is("deleted_at", null)
    .maybeSingle();
  if (!expense || expense.kind !== "expense") return { error: "Expense not found" };

  const { data: wallet } = await supabase
    .from("wallets")
    .select("currency_code, archived_at, space_id")
    .eq("id", wallet_id)
    .maybeSingle();
  if (!wallet || wallet.archived_at || wallet.space_id !== expense.space_id) return { error: "Wallet not found" };
  if (wallet.currency_code !== expense.currency_code) {
    return { error: "A repayment must be in the same currency as its expense." };
  }

  const minorUnit = minorUnitFor(wallet.currency_code);
  const precisionIssue = precisionError(amount, minorUnit, wallet.currency_code);
  if (precisionIssue) return { error: precisionIssue };

  let magnitude: number;
  try {
    magnitude = parseAmountInput(amount, minorUnit);
  } catch {
    return { error: "That amount isn't valid" };
  }
  if (magnitude === 0) return { error: "Enter an amount greater than zero" };

  const { data, error } = await supabase
    .from("transactions")
    .insert({
      wallet_id,
      space_id: wallet.space_id,
      created_by: user.id,
      kind: "refund",
      amount_minor: signedAmount("refund", magnitude),
      currency_code: wallet.currency_code,
      refund_of,
      occurred_on,
      note,
      merchant,
    })
    .select("id")
    .single();

  if (error) return { error: refundErrorMessage(error.message) ?? "Could not save repayment. Please try again." };

  revalidatePath("/", "layout");
  return { id: (data as { id: string }).id };
}
