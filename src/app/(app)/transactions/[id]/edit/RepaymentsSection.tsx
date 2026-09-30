import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { todayLocalDate } from "@/lib/today";
import { repaymentSummary } from "@/lib/refunds";
import { RepaymentForm } from "@/components/RepaymentForm";

/**
 * Under an expense's edit form: what it cost, what came back, the list of
 * repayments, and the form to record another (spec §4.3). Its own server
 * component so the edit page's tests can stub it out and so its two reads
 * only happen for expenses.
 */
export async function RepaymentsSection({
  expenseId,
  currencyCode,
  expenseMinor,
  defaultWalletId,
}: {
  expenseId: string;
  currencyCode: string;
  expenseMinor: number;
  defaultWalletId: string;
}) {
  const supabase = await createClient();
  const [{ data: repayments, error: repaymentsError }, { data: wallets, error: walletsError }] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, amount_minor, occurred_on, note, wallets!transactions_wallet_id_fkey(name)")
      .eq("refund_of", expenseId)
      .is("deleted_at", null)
      .order("occurred_on")
      .order("created_at"),
    // Same-currency, active wallets only: check_refund_parent (0030) would
    // refuse anything else, so the picker never offers it.
    supabase.from("wallets").select("id, name").eq("currency_code", currencyCode).is("archived_at", null).order("name"),
  ]);
  if (repaymentsError) throw new Error("Failed to load repayments");
  if (walletsError) throw new Error("Failed to load wallets");

  const rows = (repayments ?? []) as unknown as {
    id: string;
    amount_minor: number;
    occurred_on: string;
    note: string | null;
    wallets: { name: string } | null;
  }[];
  const { paid, repaid, share } = repaymentSummary(expenseMinor, rows.map((r) => r.amount_minor));
  const walletList = wallets ?? [];
  const startWallet = walletList.some((w) => w.id === defaultWalletId) ? defaultWalletId : (walletList[0]?.id ?? "");

  return (
    <section aria-labelledby="repayments-heading" className="mx-auto mt-8 max-w-2xl px-4 pb-8">
      <h2 id="repayments-heading" className="text-lg font-semibold" style={{ color: "var(--ink)" }}>
        Repayments
      </h2>
      <p className="mt-1 text-sm tabular-nums" style={{ color: "var(--ink-2)" }}>
        Paid {formatMoney(paid, currencyCode)} · Repaid {formatMoney(repaid, currencyCode)} · Your share{" "}
        {formatMoney(share, currencyCode)}
      </p>
      {rows.length > 0 && (
        <ul className="mt-3">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 border-b py-2 text-sm" style={{ borderColor: "var(--grid)" }}>
              <Link href={`/transactions/${r.id}/edit`} className="min-w-0 flex-1 truncate underline" style={{ color: "var(--ink)" }}>
                {r.note ?? "Repayment"}
              </Link>
              <span style={{ color: "var(--ink-2)" }}>
                {r.occurred_on} · {r.wallets?.name ?? ""}
              </span>
              <span className="tabular-nums" style={{ color: "var(--pos)" }}>
                {formatMoney(r.amount_minor, currencyCode, { signed: true })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <RepaymentForm
          mode={{ kind: "create", expenseId }}
          wallets={walletList}
          defaults={{ walletId: startWallet, amount: "", occurredOn: todayLocalDate(), note: "" }}
        />
      </div>
    </section>
  );
}
