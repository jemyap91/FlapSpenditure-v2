
const SPACE = "99999999-9999-4999-8999-999999999999";import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecurringForm } from "./RecurringForm";
import type { RecurringState } from "@/server/actions/recurring";
import type { Category } from "@/components/CategoryPicker";

// RecurringForm renders CategoryPicker, which imports `createCategory` (a
// live value, not a type) from `@/server/actions/categories` — a
// "use server" module that imports `@/lib/supabase/server` and throws at
// import time outside a configured environment (`NEXT_PUBLIC_SUPABASE_URL`
// etc. — src/lib/supabase/env.ts). `vi.mock` intercepts the import before
// that ever loads, matching TransactionForm.test.tsx's identical mock — the
// other consumer of CategoryPicker.
vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

/**
 * Mirrors WalletForm.test.tsx's own approach: assertions are on the
 * FormData the action receives, not on the visible controls. `kind`,
 * `interval_unit` and `wallet_id` are submitted through hidden inputs (see
 * RecurringForm's own long comment on why — the native radio/select
 * revert-after-failed-submit bug WalletForm.tsx first documented), so a
 * test reading the visible controls would be reading values the component
 * itself does not trust for submission.
 *
 * The mocked `action` never runs `recurringInput` itself, so fields this
 * suite leaves at their defaults (e.g. an untouched "Starts on" date) never
 * block a test submission the way they would against the real server
 * action — this file's own `defaults`-seeded edit-mode tests exercise a
 * real date value instead.
 */
const WALLETS = [
  { id: "wallet-usd", name: "Everyday", currency_code: "USD", space_id: SPACE },
  { id: "wallet-sgd", name: "Travel", currency_code: "SGD", space_id: SPACE },
  // KWD has 3 decimal places (src/lib/money.ts's MINOR_UNITS) — one more
  // than USD's 2 — specifically to exercise the reclamp-on-wallet-change
  // fix below.
  { id: "wallet-kwd", name: "Kuwait", currency_code: "KWD", space_id: SPACE },
];

const CATEGORIES: Category[] = [
  { id: "cat-rent", name: "Rent", kind: "expense", color_slot: 1, icon: "circle", space_id: SPACE },
  { id: "cat-salary", name: "Salary", kind: "income", color_slot: 2, icon: "circle", space_id: SPACE },
  { id: "cat-travel", name: "Travel fund", kind: "expense", color_slot: 3, icon: "circle", space_id: SPACE },
];

function boundAction() {
  const seen: FormData[] = [];
  const action = vi.fn(async (_p: RecurringState, fd: FormData) => {
    seen.push(fd);
    return {};
  });
  return { action, seen };
}

describe("RecurringForm in create mode", () => {
  it("derives currency_code from the selected wallet rather than offering its own control", async () => {
    const { action, seen } = boundAction();
    const user = userEvent.setup();
    render(
      <RecurringForm
        action={action}
        submitLabel="Add rule"
        pendingLabel="Adding…"
        wallets={WALLETS}
        categories={CATEGORIES}
        defaultWalletId="wallet-usd"
      />,
    );

    // No currency control anywhere.
    expect(screen.queryByRole("combobox", { name: /currency/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(seen[0]!.get("wallet_id")).toBe("wallet-usd");
    expect(seen[0]!.get("currency_code")).toBe("USD");

    // Switching the wallet select changes the derived currency.
    await user.selectOptions(screen.getByRole("combobox", { name: /wallet/i }), "wallet-sgd");
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(seen[1]!.get("wallet_id")).toBe("wallet-sgd");
    expect(seen[1]!.get("currency_code")).toBe("SGD");
  });

  it("keeps every typed value on screen after the action returns an error", async () => {
    // React 19 resets a form's DOM fields once its `action` settles — on an
    // ERROR return too, since the action still completed. The earlier
    // workaround (hidden inputs + a ref effect) covered kind/interval/
    // wallet/amount, but the plain `defaultValue` fields (name, dates)
    // were still wiped: a user fixing one bad date lost everything else
    // they had typed. Seen in the browser.
    const action = vi.fn(async (): Promise<RecurringState> => ({
      error: "End date must be on or after the anchor date.",
    }));
    const user = userEvent.setup();
    render(
      <RecurringForm
        action={action}
        submitLabel="Add rule"
        pendingLabel="Adding…"
        wallets={WALLETS}
        categories={CATEGORIES}
        defaultWalletId="wallet-usd"
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Name" }), "EndowUs DCA");
    await user.clear(screen.getByRole("textbox", { name: /^Amount/ }));
    await user.type(screen.getByRole("textbox", { name: /^Amount/ }), "800");
    await user.click(screen.getByRole("button", { name: "Rent" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "weekly");
    fireEvent.change(screen.getByLabelText("Starts on"), { target: { value: "2026-09-15" } });
    fireEvent.change(screen.getByLabelText("Ends on (optional)"), { target: { value: "2026-01-01" } });
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    // CategoryPicker mounts its own `role="alert"`, so match on the text.
    expect(await screen.findByText("End date must be on or after the anchor date.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("EndowUs DCA");
    expect(screen.getByRole("textbox", { name: /^Amount/ })).toHaveValue("800");
    expect(screen.getByRole("combobox", { name: "Repeats" })).toHaveValue("weekly");
    expect(screen.getByLabelText("Starts on")).toHaveValue("2026-09-15");
    expect(screen.getByLabelText("Ends on (optional)")).toHaveValue("2026-01-01");
  });

  it("clears every field after a successful add, so the next rule starts from a blank form", async () => {
    // The counterpart of the error case above. React's own post-action
    // reset used to clear SOME fields on success (the `defaultValue` ones)
    // and leave the state-backed ones (amount, category, kind) showing the
    // rule just added -- a half-cleared form. Opting out of that reset
    // means the form clears itself, fully, and only on success.
    const { action } = boundAction();
    const user = userEvent.setup();
    render(
      <RecurringForm
        action={action}
        submitLabel="Add rule"
        pendingLabel="Adding…"
        wallets={WALLETS}
        categories={CATEGORIES}
        defaultWalletId="wallet-usd"
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Name" }), "EndowUs DCA");
    await user.clear(screen.getByRole("textbox", { name: /^Amount/ }));
    await user.type(screen.getByRole("textbox", { name: /^Amount/ }), "800");
    await user.click(screen.getByRole("button", { name: "Rent" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "weekly");
    fireEvent.change(screen.getByLabelText("Starts on"), { target: { value: "2026-09-15" } });
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(""));
    expect(screen.getByRole("textbox", { name: /^Amount/ })).toHaveValue("0");
    expect(screen.getByRole("combobox", { name: "Repeats" })).toHaveValue("monthly");
    expect(screen.getByLabelText("Starts on")).toHaveValue("");
    // The category selection is state, not a form field: it must clear too.
    // `aria-pressed`/selected styling aside, the cheapest observable is what
    // the NEXT submission carries.
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    const second = vi.mocked(action).mock.calls[1]![1] as FormData;
    expect(second.get("category_id")).toBe("");
    expect(second.get("interval_unit")).toBe("monthly");
  });

  it("clears the selected category when the kind changes", async () => {
    const { action, seen } = boundAction();
    const user = userEvent.setup();
    render(
      <RecurringForm
        action={action}
        submitLabel="Add rule"
        pendingLabel="Adding…"
        wallets={WALLETS}
        categories={CATEGORIES}
        defaultWalletId="wallet-usd"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rent" }));
    await user.click(screen.getByText("Income"));
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    // The expense-only "Rent" category must not have survived the switch
    // to Income.
    expect(seen[0]!.get("category_id")).toBe("");
  });

  it("clears the selected category when the wallet changes", async () => {
    const { action, seen } = boundAction();
    const user = userEvent.setup();
    render(
      <RecurringForm
        action={action}
        submitLabel="Add rule"
        pendingLabel="Adding…"
        wallets={WALLETS}
        categories={CATEGORIES}
        defaultWalletId="wallet-usd"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rent" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /wallet/i }), "wallet-sgd");
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(seen[0]!.get("category_id")).toBe("");
  });

  /**
   * Fix round 1 (task-5-fix-1, Important). Reproduced live by the
   * reviewer: pick a KWD wallet (3 decimals), type 45.999, switch to a USD
   * wallet (2 decimals) — before this fix the field kept showing 45.999
   * and nothing reacted, so the eventual "USD allows up to 2 decimal
   * places" rejection on submit had nothing on screen connecting it back
   * to the wallet switch that caused it. `clampAmountInput` (src/lib/
   * money.ts) truncates to the new currency's precision, matching
   * TransactionForm's identical `handleWalletChange`.
   */
  it("clamps an over-precise amount when the new wallet's currency allows fewer decimal places", async () => {
    const { action, seen } = boundAction();
    const user = userEvent.setup();
    render(
      <RecurringForm
        action={action}
        submitLabel="Add rule"
        pendingLabel="Adding…"
        wallets={WALLETS}
        categories={CATEGORIES}
        defaultWalletId="wallet-kwd"
      />,
    );

    const amountInput = screen.getByLabelText(/Amount \(KWD\)/i);
    await user.clear(amountInput);
    await user.type(amountInput, "45.999");
    expect(amountInput).toHaveValue("45.999");

    await user.selectOptions(screen.getByRole("combobox", { name: /wallet/i }), "wallet-usd");

    // Truncated (45.99), not rounded (46.00) — parseAmountInput's own
    // truncate-not-reject rule for an over-precise fraction, applied
    // consistently here.
    expect(screen.getByLabelText(/Amount \(USD\)/i)).toHaveValue("45.99");

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(seen[0]!.get("amount")).toBe("45.99");
  });

  it("leaves the amount untouched when the new wallet's currency allows the same or more decimal places", async () => {
    const { action, seen } = boundAction();
    const user = userEvent.setup();
    render(
      <RecurringForm
        action={action}
        submitLabel="Add rule"
        pendingLabel="Adding…"
        wallets={WALLETS}
        categories={CATEGORIES}
        defaultWalletId="wallet-usd"
      />,
    );

    const amountInput = screen.getByLabelText(/Amount \(USD\)/i);
    await user.clear(amountInput);
    await user.type(amountInput, "45.5");

    await user.selectOptions(screen.getByRole("combobox", { name: /wallet/i }), "wallet-kwd");

    expect(screen.getByLabelText(/Amount \(KWD\)/i)).toHaveValue("45.5");

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(seen[0]!.get("amount")).toBe("45.5");
  });
});

describe("RecurringForm in edit mode", () => {
  const defaults = {
    wallet_id: "wallet-usd",
    name: "Rent",
    kind: "expense" as const,
    amount: "1200.00",
    category_id: "cat-rent",
    interval_unit: "monthly" as const,
    anchor_on: "2026-09-01",
    ends_on: "",
  };

  function renderEdit(action: (prev: RecurringState, fd: FormData) => Promise<RecurringState>) {
    return render(
      <RecurringForm
        action={action}
        submitLabel="Save changes"
        pendingLabel="Saving…"
        wallets={WALLETS}
        categories={CATEGORIES}
        defaultWalletId="wallet-usd"
        defaults={defaults}
        lockWallet
      />,
    );
  }

  it("offers no wallet control, but still submits the rule's wallet and currency", async () => {
    const { action, seen } = boundAction();
    const user = userEvent.setup();
    renderEdit(action);

    expect(screen.queryByRole("combobox", { name: /wallet/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Everyday/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const fd = seen[0]!;
    expect(fd.get("wallet_id")).toBe("wallet-usd");
    expect(fd.get("currency_code")).toBe("USD");
    expect(fd.get("name")).toBe("Rent");
    expect(fd.get("amount")).toBe("1200.00");
    expect(fd.get("interval_unit")).toBe("monthly");
    expect(fd.get("category_id")).toBe("cat-rent");
    expect(fd.get("anchor_on")).toBe("2026-09-01");
  });

  it("submits an empty ends_on as an empty string, not omitted", async () => {
    const { action, seen } = boundAction();
    const user = userEvent.setup();
    renderEdit(action);

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(seen[0]!.has("ends_on")).toBe(true);
    expect(seen[0]!.get("ends_on")).toBe("");
  });

  it("says wallets can't be moved once a rule exists", () => {
    renderEdit(vi.fn(async () => ({})));

    expect(screen.getByText(/does not allow moving one between wallets/i)).toBeInTheDocument();
  });
});
