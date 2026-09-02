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
import { TransactionForm, type EditSeed } from "./TransactionForm";
import { createTransaction, updateTransaction, updateTransfer } from "@/server/actions/transactions";
import type { Category } from "./CategoryPicker";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/server/actions/transactions", () => ({
  createTransaction: vi.fn(),
  createTransfer: vi.fn(),
  updateTransaction: vi.fn(),
  updateTransfer: vi.fn(),
}));

vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

const WALLET_A = "11111111-1111-4111-8111-111111111111";
const WALLET_B = "33333333-3333-4333-8333-333333333333";
const WALLET_EUR = "44444444-4444-4444-8444-444444444444";
const ORIGIN_UUID = "22222222-2222-4222-8222-222222222222";
const TXN_ID = "55555555-5555-4555-8555-555555555555";
const TRANSFER_ID = "66666666-6666-4666-8666-666666666666";

const wallets = [{ id: WALLET_A, name: "Everyday", currency_code: "USD" }];
const categories: Category[] = [
  { id: "cat-1", name: "Groceries", kind: "expense", color_slot: 1, icon: "circle", wallet_id: WALLET_A },
];

// Task 6 (editable-transactions plan): edit-mode fixtures. A second,
// same-currency wallet (WALLET_B) and a third, EUR one (WALLET_EUR) let the
// same-currency/cross-currency transfer-edit tests below share one wallets
// array rather than each building its own.
const editWallets = [
  { id: WALLET_A, name: "Everyday", currency_code: "USD" },
  { id: WALLET_B, name: "Savings", currency_code: "USD" },
  { id: WALLET_EUR, name: "Holiday", currency_code: "EUR" },
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

/**
 * Clears the amount on screen and types a new one through the keypad's own
 * buttons, exactly as a user would.
 *
 * Deleting first is not padding: a SEEDED amount is already at its currency's
 * full precision ("50.00" against USD's two decimals), and `appendDigit`
 * (src/lib/money.ts) refuses to grow a value past that — pressing a digit on
 * a seeded amount is a no-op. The keypad's Delete key is the only way to make
 * room, and `backspace()` floors at "0", so pressing it more times than there
 * are characters is harmless.
 *
 * Only ever used where ONE keypad is on screen (a non-transfer, or a
 * same-currency transfer); the cross-currency case renders two, and every
 * key would then be ambiguous.
 */
async function retypeAmount(user: ReturnType<typeof userEvent.setup>, next: string) {
  const del = screen.getByRole("button", { name: "Delete" });
  for (let i = 0; i < 8; i += 1) await user.click(del);
  for (const ch of next) await user.click(screen.getByRole("button", { name: ch }));
}

beforeEach(() => {
  push.mockClear();
  vi.mocked(createTransaction).mockReset();
  vi.mocked(createTransaction).mockResolvedValue({ id: "t1" });
  vi.mocked(updateTransaction).mockReset();
  vi.mocked(updateTransaction).mockResolvedValue({ ok: true });
  vi.mocked(updateTransfer).mockReset();
  vi.mocked(updateTransfer).mockResolvedValue({ ok: true });
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

/**
 * Task 6 (editable-transactions plan): TransactionForm's edit mode
 * (`mode="edit"` + `edit`). Context that isn't in this task's brief, all
 * binding here:
 *
 * - Wallet and kind are fixed for the life of a row — neither control
 *   renders at all in edit mode (WalletForm.tsx's own precedent: absent,
 *   not disabled).
 * - A transfer edit takes TWO amounts (`amount_out`/`amount_in`), mirroring
 *   `create_transfer` exactly, because a cross-currency transfer's legs are
 *   genuinely different amounts — the form renders two `AmountKeypad`s only
 *   when the legs' currencies differ, one otherwise (fed to both legs).
 * - `updateTransaction`/`updateTransfer` are dispatched on `edit.kind`,
 *   mirroring `updateTransaction`'s own refusal of a transfer id.
 */
describe("TransactionForm — edit mode (Task 6)", () => {
  const editTxnSeed: EditSeed = {
    kind: "expense",
    id: TXN_ID,
    walletId: WALLET_A,
    amount: "12.50",
    categoryId: "cat-1",
    occurredOn: "2026-08-01",
    note: "weekly shop",
    merchant: "Tesco",
  };

  const editTransferSameCurrency: EditSeed = {
    kind: "transfer",
    transferId: TRANSFER_ID,
    fromWalletId: WALLET_A,
    toWalletId: WALLET_B,
    amountOut: "50.00",
    amountIn: "50.00",
    occurredOn: "2026-08-02",
    note: "",
    merchant: "",
  };

  const editTransferCrossCurrency: EditSeed = {
    kind: "transfer",
    transferId: TRANSFER_ID,
    fromWalletId: WALLET_A,
    toWalletId: WALLET_EUR,
    amountOut: "50.00",
    amountIn: "45.00",
    occurredOn: "2026-08-02",
    note: "",
    merchant: "",
  };

  /**
   * Fix round 1, Minor 3. The mount effect that focuses the amount group is
   * create-mode only now. Spec §5.1's "opens focused and zeroed" is about
   * standing at a till on the ADD screen; in edit mode the amount is seeded
   * rather than zeroed, and the focus target has `tabIndex={-1}` and no
   * `FOCUS_RING`, so nothing on screen shows it is focused. `appendDigit` is
   * a no-op on a seeded full-precision amount so a digit press looks inert,
   * but `handleAmountKeyDown`'s Backspace branch is not: one press silently
   * turns 12.50 into 12.5 on a control the user cannot see has focus.
   *
   * Both halves are asserted TOGETHER, in one test, because either alone is
   * satisfiable by the wrong code: deleting the effect entirely satisfies the
   * edit half, and reverting the `isEditMode` guard satisfies the create
   * half. Only the pair pins "still on for create, off for edit."
   */
  it("focuses the amount on mount when creating, but not when editing", () => {
    const created = render(
      <TransactionForm wallets={wallets} categories={categories} defaultWalletId={WALLET_A} />,
    );
    expect(screen.getByRole("group", { name: "Amount" })).toHaveFocus();
    created.unmount();

    render(<TransactionForm mode="edit" wallets={wallets} categories={categories} edit={editTxnSeed} />);
    expect(screen.getByRole("group", { name: "Amount" })).not.toHaveFocus();
    // Nothing else grabbed it either — focus stays where a page load leaves
    // it, so the first Tab goes to the first control rather than into the
    // middle of the form.
    expect(document.body).toHaveFocus();
  });

  it("seeds every field from the transaction being edited", () => {
    render(<TransactionForm mode="edit" wallets={wallets} categories={categories} edit={editTxnSeed} />);

    // AmountKeypad's own <output aria-label="Amount"> — queried by role
    // (an <output> element's implicit ARIA role) rather than
    // `getByLabelText`, since that would also match the WRAPPING group div
    // below it (`role="group" aria-labelledby={amountLabelId}`, whose
    // referenced label text is the identical "Amount" for a non-transfer
    // edit), and ambiguously return two elements.
    expect(screen.getByRole("status", { name: "Amount" }).textContent).toContain("12.50");
    // CategoryPicker highlights the seeded selection via aria-pressed, and
    // the chip above it (TransactionForm's own <span>) shows its name.
    expect(screen.getByRole("button", { name: "Groceries" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("2026-08-01")).toBeInTheDocument();
    expect(screen.getByDisplayValue("weekly shop")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Tesco")).toBeInTheDocument();
    // The fixed wallet is stated as text, not a selectable value.
    expect(screen.getByText("Everyday")).toBeInTheDocument();
  });

  it("offers no wallet or kind control — neither is editable", () => {
    // Absent, not disabled: this codebase's convention for a control that
    // can never succeed (TransactionForm removes the category chip on a
    // transfer; WalletList renders no Archive for a non-owner).
    render(<TransactionForm mode="edit" wallets={wallets} categories={categories} edit={editTxnSeed} />);
    expect(screen.queryByRole("combobox", { name: /Wallet/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("offers no category control when editing a transfer", () => {
    render(
      <TransactionForm
        mode="edit"
        wallets={editWallets}
        categories={categories}
        edit={editTransferSameCurrency}
      />,
    );
    expect(screen.queryByLabelText("Search categories")).not.toBeInTheDocument();
    expect(screen.queryByText("Choose category")).not.toBeInTheDocument();
  });

  it("says it is editing both legs of a transfer", () => {
    render(
      <TransactionForm
        mode="edit"
        wallets={editWallets}
        categories={categories}
        edit={editTransferSameCurrency}
      />,
    );
    expect(screen.getByText(/both legs/i)).toBeInTheDocument();
  });

  it("renders one amount field when a transfer's legs share a currency", () => {
    render(
      <TransactionForm
        mode="edit"
        wallets={editWallets}
        categories={categories}
        edit={editTransferSameCurrency}
      />,
    );
    expect(screen.getAllByLabelText("Amount")).toHaveLength(1);
  });

  it("renders two amount fields when a transfer's legs' currencies differ", () => {
    render(
      <TransactionForm
        mode="edit"
        wallets={editWallets}
        categories={categories}
        edit={editTransferCrossCurrency}
      />,
    );
    expect(screen.getAllByLabelText("Amount")).toHaveLength(2);
  });

  it("edits a non-transfer transaction via updateTransaction and redirects to /transactions", async () => {
    const user = userEvent.setup();
    render(<TransactionForm mode="edit" wallets={wallets} categories={categories} edit={editTxnSeed} />);

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/transactions"));
    expect(updateTransaction).toHaveBeenCalledWith({
      id: TXN_ID,
      amount: "12.50",
      category_id: "cat-1",
      occurred_on: "2026-08-01",
      note: "weekly shop",
      merchant: "Tesco",
    });
    // updateTransfer must never be called for a non-transfer edit — this is
    // the dispatch-on-kind contract, not just "some save happened."
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it("edits a same-currency transfer via updateTransfer, sending one amount for both legs", async () => {
    const user = userEvent.setup();
    render(
      <TransactionForm
        mode="edit"
        wallets={editWallets}
        categories={categories}
        edit={editTransferSameCurrency}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/transactions"));
    expect(updateTransfer).toHaveBeenCalledWith({
      transfer_id: TRANSFER_ID,
      amount_out: "50.00",
      amount_in: "50.00",
      occurred_on: "2026-08-02",
      note: "",
      merchant: "",
    });
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  it("edits a cross-currency transfer via updateTransfer, sending each leg's own amount", async () => {
    const user = userEvent.setup();
    render(
      <TransactionForm
        mode="edit"
        wallets={editWallets}
        categories={categories}
        edit={editTransferCrossCurrency}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/transactions"));
    expect(updateTransfer).toHaveBeenCalledWith({
      transfer_id: TRANSFER_ID,
      amount_out: "50.00",
      amount_in: "45.00",
      occurred_on: "2026-08-02",
      note: "",
      merchant: "",
    });
  });

  /**
   * Fix round 1, IMPORTANT 3. No test in this suite typed into a keypad in
   * edit mode — every dispatch test clicked Save on untouched seed values, so
   * the feature's entire purpose (changing something) was uncovered, and both
   * transfer fixtures seed `amountOut === amountIn === "50.00"`, which made
   * the same-currency arm of
   *
   *     amount_in: crossCurrency ? amountIn : amount
   *
   * invisible: the reviewer replaced it with `amount_in: amountIn` and all 18
   * tests still passed.
   *
   * What that regression does in production: a user editing a same-currency
   * transfer from 50.00 to 60.00 posts `amount_out: "60.00"` with
   * `amount_in: "50.00"`; `update_transfer_pair` raises "a same-currency
   * transfer must balance"; that transfer can never be edited again.
   *
   * This test cannot pass under it. A same-currency transfer renders only the
   * SOURCE keypad, so `amountIn` state never leaves its "50.00" seed no
   * matter what the user types — the one field the user CAN touch has to feed
   * both legs, and asserting the new value in `amount_in` is what proves it
   * does. (The seeds stay balanced at 50.00/50.00 on purpose: an unbalanced
   * same-currency pair is a schema state `create_transfer` never produces,
   * and the mismatch this test needs comes from the edit, not the fixture.)
   */
  it("sends a same-currency transfer's newly typed amount as BOTH legs' amounts", async () => {
    const user = userEvent.setup();
    render(
      <TransactionForm
        mode="edit"
        wallets={editWallets}
        categories={categories}
        edit={editTransferSameCurrency}
      />,
    );

    await retypeAmount(user, "60.00");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/transactions"));
    expect(updateTransfer).toHaveBeenCalledWith({
      transfer_id: TRANSFER_ID,
      amount_out: "60.00",
      amount_in: "60.00",
      occurred_on: "2026-08-02",
      note: "",
      merchant: "",
    });
  });

  /**
   * The non-transfer half of the same gap: an edit that actually CHANGES
   * something. Two fields at once (the amount, through the keypad; the note,
   * through its input) so a regression that froze either one at its seed —
   * sending `edit.amount` instead of the `amount` state, say — fails here
   * rather than passing on values the fixture supplied in the first place.
   * `merchant` is deliberately left untouched and still asserted: an
   * unchanged field must survive an edit, not be blanked by it.
   */
  it("sends a non-transfer edit's newly typed amount and note to updateTransaction", async () => {
    const user = userEvent.setup();
    render(<TransactionForm mode="edit" wallets={wallets} categories={categories} edit={editTxnSeed} />);

    await retypeAmount(user, "9.99");
    const note = screen.getByLabelText("Note");
    await user.clear(note);
    await user.type(note, "corrected note");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/transactions"));
    expect(updateTransaction).toHaveBeenCalledWith({
      id: TXN_ID,
      amount: "9.99",
      category_id: "cat-1",
      occurred_on: "2026-08-01",
      note: "corrected note",
      merchant: "Tesco",
    });
  });

  /**
   * Fix round 1, Minor 1: the edit path's post-save redirect was hardcoded
   * to "/transactions", reintroducing on the edit path the exact regression
   * the create path documents having fixed — a user on /wallets/<id> who
   * taps a row, fixes a note and saves was dumped on the global list.
   *
   * Asserted on `push`'s ARGUMENT, the same rule the create-path suite at the
   * top of this file states: "the edit succeeded" would still pass with the
   * redirect wired straight to `router.push(from)`, which is the open
   * redirect `parseOrigin` exists to remove. The garbage-`from` case below is
   * what guards that boundary — without it, this pair is satisfied by
   * `router.push(from ?? "/transactions")`.
   */
  it("returns to the originating wallet after an edit when from names one", async () => {
    const user = userEvent.setup();
    render(
      <TransactionForm
        mode="edit"
        wallets={wallets}
        categories={categories}
        edit={editTxnSeed}
        from={`wallet:${ORIGIN_UUID}`}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/wallets/${ORIGIN_UUID}`));
  });

  it("refuses an attacker-supplied from after an edit and goes to /transactions instead", async () => {
    const user = userEvent.setup();
    render(
      <TransactionForm
        mode="edit"
        wallets={wallets}
        categories={categories}
        edit={editTxnSeed}
        from="https://evil.example"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/transactions"));
  });

  it("surfaces the server's error and does not redirect when the edit fails", async () => {
    vi.mocked(updateTransaction).mockResolvedValue({ error: "This wallet has been archived." });
    const user = userEvent.setup();
    render(<TransactionForm mode="edit" wallets={wallets} categories={categories} edit={editTxnSeed} />);

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("This wallet has been archived.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
