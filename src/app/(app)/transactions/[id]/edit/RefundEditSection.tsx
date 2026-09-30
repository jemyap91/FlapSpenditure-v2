import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatAmountInput, minorUnitFor } from "@/lib/money";
import { RepaymentForm } from "@/components/RepaymentForm";

/** Editing one refund: which expense it repays, and its own fields. */
export async function RefundEditSection({ id }: { id: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("transactions")
    .select("id, wallet_id, amount_minor, currency_code, occurred_on, note, refund_of, repaid_expense(id, occurred_on, merchant, note)")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error("Failed to load repayment");
  const row = data as unknown as {
    id: string;
    wallet_id: string;
    amount_minor: number;
    currency_code: string;
    occurred_on: string;
    note: string | null;
    refund_of: string;
    repaid_expense: { id: string; occurred_on: string; merchant: string | null; note: string | null } | null;
  } | null;
  if (!row) return null;

  const { data: wallets, error: walletsError } = await supabase
    .from("wallets")
    .select("id, name")
    .eq("currency_code", row.currency_code)
    .is("archived_at", null)
    .order("name");
  if (walletsError) throw new Error("Failed to load wallets");

  const expense = row.repaid_expense;
  const expenseName = expense?.merchant?.trim() || expense?.note?.trim() || "an expense";

  return (
    <div className="mx-auto max-w-2xl p-4">
      <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>
        Repayment for{" "}
        {expense ? (
          <Link href={`/transactions/${expense.id}/edit`} className="underline">
            {expenseName}
          </Link>
        ) : (
          expenseName
        )}
        {expense ? ` · ${expense.occurred_on}` : ""}
      </h1>
      <div className="mt-4">
        <RepaymentForm
          mode={{ kind: "edit", id: row.id, expenseId: row.refund_of }}
          wallets={wallets ?? []}
          defaults={{
            walletId: row.wallet_id,
            amount: formatAmountInput(row.amount_minor, minorUnitFor(row.currency_code)),
            occurredOn: row.occurred_on,
            note: row.note ?? "",
          }}
        />
      </div>
    </div>
  );
}
