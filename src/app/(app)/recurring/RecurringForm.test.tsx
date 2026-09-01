import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  { id: "wallet-usd", name: "Everyday", currency_code: "USD" },
  { id: "wallet-sgd", name: "Travel", currency_code: "SGD" },
];

const CATEGORIES: Category[] = [
  { id: "cat-rent", name: "Rent", kind: "expense", color_slot: 1, icon: "circle", wallet_id: "wallet-usd" },
  { id: "cat-salary", name: "Salary", kind: "income", color_slot: 2, icon: "circle", wallet_id: "wallet-usd" },
  { id: "cat-travel", name: "Travel fund", kind: "expense", color_slot: 3, icon: "circle", wallet_id: "wallet-sgd" },
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
