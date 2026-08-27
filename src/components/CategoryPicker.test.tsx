// src/components/CategoryPicker.test.tsx
//
// `@/server/actions/categories` carries a file-level "use server" and
// transitively reaches `@/lib/supabase/server` -> `next/headers` /
// `server-only`. `npm test` runs with NO `.env.local`, so that import chain
// must never execute — `vi.mock` below intercepts it before the real module
// loads, the same technique src/server/actions/invites.test.ts and
// src/app/(app)/wallets/WalletList.test.tsx already use.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryPicker, type Category } from "./CategoryPicker";
import { createCategory } from "@/server/actions/categories";

vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

const WALLET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WALLET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const cat = (over: Partial<Category> & Pick<Category, "id" | "name" | "wallet_id">): Category => ({
  kind: "expense",
  color_slot: 1,
  icon: "circle",
  ...over,
});

const groceriesA = cat({ id: "cat-a", name: "Groceries", wallet_id: WALLET_A });
const groceriesB = cat({ id: "cat-b", name: "Groceries", wallet_id: WALLET_B });

/** What the fixed `createCategory` returns for an inline "Vet" created
 *  under wallet A: `wallet_id` is part of the row (it is selected by the
 *  action), which is what lets the picker tell the two wallets apart. */
const vetInWalletA = {
  id: "vet-a",
  name: "Vet",
  kind: "expense" as const,
  color_slot: 3,
  icon: "circle",
  wallet_id: WALLET_A,
};

beforeEach(() => {
  vi.mocked(createCategory).mockReset();
  vi.mocked(createCategory).mockResolvedValue({ category: vetInWalletA });
});

describe("CategoryPicker — inline-created categories are wallet-scoped", () => {
  /**
   * Regression test for the cross-wallet leak that produced an UNSAVABLE
   * transaction: inline-create "Vet" under wallet A, switch the Wallet
   * chip to wallet B (TransactionForm re-renders this same mounted picker
   * with a new `walletId` and B's own category list), and "Vet" was still
   * offered. Selecting it and saving got as far as the INSERT, where
   * 0008's composite FK `transactions_category_same_wallet` rejected it —
   * surfacing only as "Could not save transaction. Please try again.",
   * forever.
   *
   * The positive control matters as much as the absence assertion: the
   * created category MUST still be listed under the wallet it was created
   * in, or a picker that simply dropped every inline creation would pass
   * the second half of this test while breaking the whole feature.
   */
  it("does not offer a category created under one wallet once another wallet is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <CategoryPicker
        categories={[groceriesA]}
        kind="expense"
        value={null}
        onChange={onChange}
        walletId={WALLET_A}
      />,
    );

    await user.type(screen.getByLabelText(/search categories/i), "Vet");
    await user.click(screen.getByRole("button", { name: /^Create/ }));

    // Positive control: it IS offered (and selected) under wallet A.
    expect(await screen.findByRole("button", { name: "Vet" })).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "vet-a" }));

    // TransactionForm's Wallet chip changed: same mounted picker, new
    // walletId, and only wallet B's own categories in the prop.
    rerender(
      <CategoryPicker
        categories={[groceriesB]}
        kind="expense"
        value={null}
        onChange={onChange}
        walletId={WALLET_B}
      />,
    );

    expect(screen.getByRole("button", { name: "Groceries" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vet" })).not.toBeInTheDocument();
  });

  it("offers the inline-created category again when the original wallet is reselected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <CategoryPicker
        categories={[groceriesA]}
        kind="expense"
        value={null}
        onChange={onChange}
        walletId={WALLET_A}
      />,
    );

    await user.type(screen.getByLabelText(/search categories/i), "Vet");
    await user.click(screen.getByRole("button", { name: /^Create/ }));
    await screen.findByRole("button", { name: "Vet" });

    rerender(
      <CategoryPicker
        categories={[groceriesB]}
        kind="expense"
        value={null}
        onChange={onChange}
        walletId={WALLET_B}
      />,
    );
    rerender(
      <CategoryPicker
        categories={[groceriesA]}
        kind="expense"
        value={null}
        onChange={onChange}
        walletId={WALLET_A}
      />,
    );

    // Filtered, not discarded: the parent's `categories` prop has not
    // revalidated yet, so this is still the only place "Vet" can come from.
    expect(screen.getByRole("button", { name: "Vet" })).toBeInTheDocument();
  });
});
