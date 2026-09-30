"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createRefund } from "@/server/actions/refunds";
import { updateTransaction } from "@/server/actions/transactions";

type Mode = { kind: "create"; expenseId: string } | { kind: "edit"; id: string; expenseId: string };

const FIELD =
  "w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * One repayment's fields (spec §4.3). A plain decimal text input, not the
 * AmountKeypad: this form sits under an already-full expense form, and
 * recording four friends in a row is faster typed than tapped.
 *
 * Create mode clears the amount and note after a save and stays put, so the
 * next friend can be entered immediately; the server component above
 * re-renders the list and summary via router.refresh(). Edit mode returns
 * to the expense.
 */
export function RepaymentForm({
  mode,
  wallets,
  defaults,
}: {
  mode: Mode;
  wallets: { id: string; name: string }[];
  defaults: { walletId: string; amount: string; occurredOn: string; note: string };
}) {
  const router = useRouter();
  const [walletId, setWalletId] = useState(defaults.walletId);
  const [amount, setAmount] = useState(defaults.amount);
  const [occurredOn, setOccurredOn] = useState(defaults.occurredOn);
  const [note, setNote] = useState(defaults.note);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const common = { wallet_id: walletId, amount, occurred_on: occurredOn, note: note.trim() || null, merchant: null };
      const result =
        mode.kind === "create"
          ? await createRefund({ refund_of: mode.expenseId, ...common })
          : await updateTransaction({ id: mode.id, category_id: null, ...common });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      if (mode.kind === "create") {
        setAmount("");
        setNote("");
        router.refresh();
      } else {
        router.push(`/transactions/${mode.expenseId}/edit`);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--ink-2)" }}>
          Wallet
          <select
            aria-label="Repayment wallet"
            className={FIELD}
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--ink-2)" }}>
          Amount
          <input
            aria-label="Repayment amount"
            className={`${FIELD} tabular-nums`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--ink-2)" }}>
          Date
          <input
            aria-label="Repayment date"
            type="date"
            className={FIELD}
            value={occurredOn}
            onChange={(e) => setOccurredOn(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--ink-2)" }}>
          Note
          <input
            aria-label="Repayment note"
            className={FIELD}
            maxLength={280}
            placeholder="Who paid you back"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]"
        style={{ background: "var(--ink)", color: "var(--page)" }}
      >
        {mode.kind === "create" ? "Record repayment" : "Save repayment"}
      </button>
    </form>
  );
}
