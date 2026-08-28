// src/components/TransactionForm.test.tsx
//
// Task 4 (wallet-detail plan): TransactionForm's post-save redirect now
// depends on a `from` prop instead of being hardcoded to "/transactions".
// The controller addendum is explicit about what the assertion has to be:
// the DESTINATION the router is pushed to, not merely that a transaction
// was recorded — a test that only checked the save succeeded would still
// pass with the redirect wired directly to router.push(from), which is
// exactly the open-redirect `src/lib/origin.ts`'s `parseOrigin` exists to
// remove. Every test below asserts on `push`'s argument.
//
// `@/server/actions/transactions` is mocked because its real module carries
// a file-level "use server" boundary reaching `@/lib/supabase/server` ->
// `next/headers`, which throws outside a request scope — same precedent as
// src/components/CategoryPicker.test.tsx mocking `@/server/actions/categories`.
// This form also mounts CategoryPicker itself, which independently imports
// `@/server/actions/categories` (its own "use server" module) to inline-
// create a category — that has to be mocked here too, for the same reason.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TransactionForm } from "./TransactionForm";
import { createTransaction } from "@/server/actions/transactions";
import type { Category } from "./CategoryPicker";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/server/actions/transactions", () => ({
  createTransaction: vi.fn(),
  createTransfer: vi.fn(),
}));

vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

const WALLET_A = "11111111-1111-4111-8111-111111111111";
const ORIGIN_UUID = "22222222-2222-4222-8222-222222222222";

const wallets = [{ id: WALLET_A, name: "Everyday", currency_code: "USD" }];
const categories: Category[] = [
  { id: "cat-1", name: "Groceries", kind: "expense", color_slot: 1, icon: "circle", wallet_id: WALLET_A },
];

/** Fills the minimum a save needs (a nonzero amount, a category) and clicks
 *  Save, then waits for the redirect that follows a successful save. */
async function saveAnExpense(from?: string) {
  const user = userEvent.setup();
  render(
    <TransactionForm wallets={wallets} categories={categories} defaultWalletId={WALLET_A} from={from} />,
  );
  await user.click(screen.getByRole("button", { name: "5" }));
  await user.click(screen.getByRole("button", { name: "Groceries" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(push).toHaveBeenCalled());
}

beforeEach(() => {
  push.mockClear();
  vi.mocked(createTransaction).mockReset();
  vi.mocked(createTransaction).mockResolvedValue({ id: "t1" });
});

describe("TransactionForm — post-save redirect (Task 4)", () => {
  it("returns to the originating wallet when from names one", async () => {
    await saveAnExpense(`wallet:${ORIGIN_UUID}`);
    expect(push).toHaveBeenCalledWith(`/wallets/${ORIGIN_UUID}`);
  });

  it("goes to /transactions when from is absent, exactly as before", async () => {
    await saveAnExpense(undefined);
    expect(push).toHaveBeenCalledWith("/transactions");
  });

  // The reason parseOrigin exists: a redirect target taken from user input
  // is an open-redirect vector. This is the adversarial case — the browser
  // must land somewhere SAFE, not wherever the query string said.
  it("refuses an attacker-supplied absolute URL and goes to /transactions instead", async () => {
    await saveAnExpense("https://evil.example");
    expect(push).toHaveBeenCalledWith("/transactions");
  });
});
