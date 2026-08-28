// src/app/(app)/budgets/BudgetList.test.tsx
//
// Rewritten for the wallet-SET budget model (task-6-brief.md +
// CONTROLLER ADDENDUM). `BudgetStatusRow` is imported from
// "@/lib/budget-status", never redefined here — see that file's own doc
// comment on why: it is the nullability-corrected shape of
// `get_budget_status`'s (0013) generated row type, and defining a local
// shadow of it is exactly the mistake that shipped an `undefined 2026`
// heading on the previous branch.
//
// Two row "kinds" arrive in the same `rows` array (controller addendum §1):
// - a BUDGET row: `budget_id`, `category_key`/`category_label` (null only
//   for the overall cap), `wallet_names`, `wallet_count`, `budget_minor`,
//   `budget_period_start` all non-null.
// - an UNCOVERED-spending row: all five of those are null; `budget_minor`
//   null means "no target", never zero.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BudgetList } from "./BudgetList";
import { removeBudget, setBudget } from "@/server/actions/budgets";
import type { BudgetStatusRow } from "@/lib/budget-status";

vi.mock("@/server/actions/budgets", () => ({ setBudget: vi.fn(), removeBudget: vi.fn() }));

/** A BUDGETED row (overall cap or category), matching the "budget row" shape. */
const row = (over: Partial<BudgetStatusRow> = {}): BudgetStatusRow => ({
  budget_id: "b1",
  category_key: "groceries",
  category_label: "Groceries",
  currency_code: "SGD",
  wallet_names: ["Everyday"],
  wallet_count: 1,
  spent_minor: 0,
  budget_minor: 60000,
  budget_period_start: "2026-08-01",
  ...over,
});

/** An UNCOVERED-spending row — no budget covers this category for this wallet. */
const uncoveredRow = (over: Partial<BudgetStatusRow> = {}): BudgetStatusRow => ({
  budget_id: null,
  category_key: "dining",
  category_label: "Dining",
  currency_code: "SGD",
  wallet_names: null,
  wallet_count: null,
  spent_minor: 0,
  budget_minor: null,
  budget_period_start: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(removeBudget).mockResolvedValue({});
  vi.mocked(setBudget).mockResolvedValue({});
});

describe("BudgetList — rendering a budgeted row", () => {
  it("renders spending against its cap with a percent and its scope label", () => {
    render(
      <BudgetList
        rows={[row({ spent_minor: 41200, budget_minor: 60000, wallet_names: ["Everyday"], wallet_count: 1 })]}
      />,
    );
    expect(screen.getByText(/SGD 412\.00 of SGD 600\.00 · 69%/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Groceries · Everyday" })).toBeInTheDocument();
    // Positive control for the null-budget test's `.h-2` absence assertion
    // below: without this, a rename of the bar's class would make that
    // absence assertion pass vacuously forever instead of catching drift.
    expect(document.querySelector(".h-2")).toBeInTheDocument();
  });

  it("states an overrun in words, never by colour alone, in its own paragraph", () => {
    render(<BudgetList rows={[row({ spent_minor: 24500, budget_minor: 20000 })]} />);
    const overPara = screen.getByText(/over by SGD 45\.00/i);
    expect(overPara.tagName).toBe("P");
  });
});

describe("BudgetList — an uncovered category", () => {
  it("renders untracked spending with no percent and no bar", () => {
    render(<BudgetList rows={[uncoveredRow({ spent_minor: 9000, category_label: "Dining" })]} />);
    expect(screen.getByText(/SGD 90\.00 spent · No budget set/)).toBeInTheDocument();
    expect(screen.queryByText(/over by/i)).not.toBeInTheDocument();
    // Step 3 requires BOTH "no percent" and "no bar" — an absence-only check
    // on "over by" would still pass a regression that folded a null budget
    // into `budget_minor ?? 0` (budgetProgress already guards that case, but
    // that regression would ALSO start rendering a 0%-wide bar and "0%"
    // text, which these two assertions catch).
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    expect(document.querySelector(".h-2")).not.toBeInTheDocument();
  });
});

describe("BudgetList — two budgets, same category, different scopes", () => {
  it("renders both as their own rows, each with its own scope label", () => {
    render(
      <BudgetList
        rows={[
          row({ budget_id: "b1", wallet_names: ["Everyday"], wallet_count: 1 }),
          row({ budget_id: "b2", wallet_names: ["Savings"], wallet_count: 1 }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Groceries · Everyday" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Groceries · Savings" })).toBeInTheDocument();
  });

  it("names each row's live regions distinctly — fix round I2, categoryLabel alone collided here", () => {
    render(
      <BudgetList
        rows={[
          row({ budget_id: "b1", wallet_names: ["Everyday"], wallet_count: 1 }),
          row({ budget_id: "b2", wallet_names: ["Savings"], wallet_count: 1 }),
        ]}
      />,
    );
    // Both rows share `categoryLabel` ("Groceries") — before this fix both
    // alerts (and both status regions) were named identically "Error for
    // Groceries" / "Status for Groceries", making getByRole ambiguous for
    // exactly the scenario this describe block renders.
    expect(screen.getByRole("alert", { name: "Error for Groceries · Everyday" })).toBeInTheDocument();
    expect(screen.getByRole("alert", { name: "Error for Groceries · Savings" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Status for Groceries · Everyday" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Status for Groceries · Savings" })).toBeInTheDocument();
  });
});

describe("BudgetList — heading semantics", () => {
  it("is an h2 (level 2), not merely something styled to look like one", () => {
    render(<BudgetList rows={[row()]} />);
    const heading = screen.getByRole("heading", { name: "Groceries · Everyday" });
    expect(heading.tagName).toBe("H2");
  });

  it("labels the overall cap distinctly from a category, still as an h2", () => {
    render(
      <BudgetList
        rows={[
          row({
            budget_id: "b-overall",
            category_key: null,
            category_label: null,
            wallet_names: ["Everyday", "Savings"],
            wallet_count: 2,
          }),
        ]}
        wallets={[
          { id: "w1", name: "Everyday", currency_code: "SGD" },
          { id: "w2", name: "Savings", currency_code: "SGD" },
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Overall budget · All wallets" }),
    ).toBeInTheDocument();
  });
});

describe("BudgetList — grouping and order", () => {
  it("orders overall caps first, then budgeted categories alphabetically, then uncovered spending — regardless of input order", () => {
    render(
      <BudgetList
        rows={[
          uncoveredRow({ category_key: "dining", category_label: "Dining", spent_minor: 100 }),
          row({ budget_id: "b-zebra", category_key: "zebra", category_label: "Zebra" }),
          row({ budget_id: "b-overall", category_key: null, category_label: null }),
          row({ budget_id: "b-mango", category_key: "mango", category_label: "Mango" }),
        ]}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    // "Add a budget" is the always-mounted new-budget section's own h2
    // (matching (app)/wallets/page.tsx's "Add a wallet" heading, also an
    // h2 alongside its list) — trailing here rather than absent, since
    // every OTHER heading assertion in this file targets one by its exact
    // pinned name and would not otherwise notice it moved.
    expect(headings).toEqual([
      "Overall budget · Everyday",
      "Mango · Everyday",
      "Zebra · Everyday",
      "Uncovered spending",
      "Add a budget",
    ]);
    expect(screen.getByText(/Dining/)).toBeInTheDocument();
  });
});

describe("BudgetList — never sums rows into a total", () => {
  it("does not render any combined total across an overall cap and a category row that double-counts the same spending", () => {
    // The overall cap's own spent_minor (74500) already includes the
    // Groceries spending reported a second time as its own budgeted-category
    // row (41200) — this is correct per the controller addendum, and the
    // component must show each row's own figure, never spentA + spentB.
    render(
      <BudgetList
        rows={[
          row({ budget_id: "b-overall", category_key: null, category_label: null, spent_minor: 74500, budget_minor: 95000 }),
          row({ budget_id: "b-groceries", category_key: "groceries", category_label: "Groceries", spent_minor: 41200, budget_minor: 60000 }),
        ]}
      />,
    );
    expect(screen.getByText(/SGD 745\.00 of SGD 950\.00/)).toBeInTheDocument();
    expect(screen.getByText(/SGD 412\.00 of SGD 600\.00/)).toBeInTheDocument();
    // 745 + 412 = 1157 — must never appear anywhere as a combined figure.
    expect(screen.queryByText(/1,157|1157\.00/)).not.toBeInTheDocument();
  });
});

describe("BudgetList — Remove", () => {
  it("offers Remove, pinned by name, on a category budget", () => {
    render(<BudgetList rows={[row({ category_label: "Groceries", budget_id: "b1" })]} />);
    expect(screen.getByRole("button", { name: "Remove budget for Groceries · Everyday" })).toBeInTheDocument();
  });

  it("offers Remove, pinned by name, on the overall cap", () => {
    render(<BudgetList rows={[row({ category_key: null, category_label: null, budget_id: "b1" })]} />);
    expect(screen.getByRole("button", { name: "Remove overall budget · Everyday" })).toBeInTheDocument();
  });

  it("clicking Remove calls removeBudget with the row's real budget id", async () => {
    const user = userEvent.setup();
    render(<BudgetList rows={[row({ category_label: "Groceries", budget_id: "b1" })]} />);
    await user.click(screen.getByRole("button", { name: "Remove budget for Groceries · Everyday" }));
    expect(removeBudget).toHaveBeenCalledExactlyOnceWith("b1");
  });

  it("surfaces a Remove failure in its OWN row's alert, named for that row", async () => {
    vi.mocked(removeBudget).mockResolvedValue({ error: "Could not remove that budget. Please try again." });
    const user = userEvent.setup();
    render(<BudgetList rows={[row({ category_label: "Groceries", budget_id: "b1" })]} />);
    await user.click(screen.getByRole("button", { name: "Remove budget for Groceries · Everyday" }));
    // "Error for Groceries · Everyday", not just "Error for Groceries" — the
    // default `row()` fixture's own scope, per fix round I2's naming fix.
    expect(await screen.findByRole("alert", { name: "Error for Groceries · Everyday" })).toHaveTextContent(
      "Could not remove that budget. Please try again.",
    );
  });
});

describe("BudgetList — Remove, a budget carried forward from an earlier month (fix round C1)", () => {
  // Restored as a direct port of commit d8968fe's own three cases, after
  // being dropped (along with the feature) in the initial wallet-set
  // rewrite on the mistaken belief that carry-forward "doesn't map onto
  // wallet sets" — it does, just keyed on (wallet set, category) now
  // instead of (wallet, category). See `monthAbbrev`'s own doc comment in
  // BudgetList.tsx.
  it("discloses a budget carried forward from an earlier month in the VISIBLE text, keeping the aria-label pinned", () => {
    render(
      <BudgetList
        rows={[row({ category_label: "Groceries", budget_id: "b1", budget_period_start: "2026-06-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    const button = screen.getByRole("button", { name: "Remove budget for Groceries · Everyday" });
    // The aria-label (queried above) is the pinned string, byte-identical.
    // The VISIBLE text is what carries the disclosure.
    expect(button).toHaveTextContent("Remove (set Jun)");
    // Same calendar year as `currentPeriodStart` — no year digits.
    expect(button).not.toHaveTextContent(/\d{4}/);
  });

  it("includes the year in the qualifier when the budget was set in an EARLIER calendar year", () => {
    render(
      <BudgetList
        rows={[row({ category_label: "Groceries", budget_id: "b1", budget_period_start: "2025-08-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    const button = screen.getByRole("button", { name: "Remove budget for Groceries · Everyday" });
    expect(button).toHaveTextContent("Remove (set Aug 2025)");
  });

  it("does not disclose a past-month qualifier for a budget set THIS month", () => {
    render(
      <BudgetList
        rows={[row({ category_label: "Groceries", budget_id: "b1", budget_period_start: "2026-08-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    const button = screen.getByRole("button", { name: "Remove budget for Groceries · Everyday" });
    expect(button).toHaveTextContent("Remove");
    expect(button).not.toHaveTextContent(/\(set/);
  });
});

describe("BudgetList — an existing row resubmits its OWN wallet set, not the picker's", () => {
  it("includes the row's resolved wallet ids as hidden fields when saving its amount", async () => {
    // Row-scoped: "Budget amount"/"Save budget" render once per row (the
    // controller addendum's own pinned-names note) — this row's own AND the
    // always-mounted new-budget form's — so an unscoped screen.getByLabelText
    // here would ambiguously match both.
    const user = userEvent.setup();
    render(
      <BudgetList
        rows={[row({ budget_id: "b1", category_label: "Groceries", wallet_names: ["Everyday"], wallet_count: 1 })]}
        walletIdsByBudget={{ b1: ["w-everyday"] }}
      />,
    );
    const rowSection = screen.getByRole("heading", { level: 2, name: "Groceries · Everyday" }).closest("section")!;
    await user.type(within(rowSection).getByLabelText("Budget amount"), "600");
    await user.click(within(rowSection).getByRole("button", { name: "Save budget" }));
    expect(setBudget).toHaveBeenCalled();
    const formData = vi.mocked(setBudget).mock.calls[0]![2] as FormData;
    expect(formData.getAll("walletIds")).toEqual(["w-everyday"]);
    expect(vi.mocked(setBudget).mock.calls[0]![0]).toBe("groceries");
  });
});

describe("BudgetList — save error accessibility", () => {
  it("associates a save error with the amount input via a describedby target that carries no competing aria-label", async () => {
    // Same reasoning as the previous branch's fix round 2, item 1: an
    // aria-label on the describedby TARGET wins over that node's own text
    // content per the WAI-ARIA Accessible Name and Description Computation,
    // so the label must live on an unlabelled child, never the referenced
    // node itself.
    vi.mocked(setBudget).mockResolvedValue({ error: "Enter an amount like 600 or 600.50" });
    const user = userEvent.setup();
    // `walletIdsByBudget` must match the default row's `wallet_count: 1` —
    // fix round I5 disables Save whenever `walletIds.length !== wallet_count`
    // (the archived-wallet-mismatch guard), and an unsupplied map defaults
    // to `[]`, which would trip that guard here for an entirely unrelated
    // reason and silently prevent the click below from ever submitting.
    render(
      <BudgetList rows={[row({ category_label: "Groceries", budget_id: "b1" })]} walletIdsByBudget={{ b1: ["w1"] }} />,
    );

    const rowSection = screen.getByRole("heading", { level: 2, name: "Groceries · Everyday" }).closest("section")!;
    const input = within(rowSection).getByLabelText("Budget amount");
    await user.type(input, "abc");
    await user.click(within(rowSection).getByRole("button", { name: "Save budget" }));
    await within(rowSection).findByText("Enter an amount like 600 or 600.50");

    expect(input).toHaveAccessibleDescription("Enter an amount like 600 or 600.50");

    const describedbyId = input.getAttribute("aria-describedby");
    expect(describedbyId).toBeTruthy();
    const target = document.getElementById(describedbyId!);
    expect(target).toHaveTextContent("Enter an amount like 600 or 600.50");
    expect(target).not.toHaveAttribute("aria-label");
  });
});

describe("BudgetList — adding a new budget", () => {
  const wallets = [
    { id: "w1", name: "Everyday", currency_code: "SGD" },
    { id: "w2", name: "Savings", currency_code: "SGD" },
  ];
  const categories = [{ key: "groceries", label: "Groceries" }];

  it("offers a Category picker and a wallet picker, pinned by name", () => {
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Wallets this budget covers" })).toBeInTheDocument();
  });

  it("defaults the wallet picker to every wallet in the primary currency, all checked", () => {
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    const everyday = screen.getByRole("checkbox", { name: "Everyday" });
    const savings = screen.getByRole("checkbox", { name: "Savings" });
    expect(everyday).toBeChecked();
    expect(savings).toBeChecked();
  });

  it("submits the chosen category as an explicit null for the overall option, never an empty string", async () => {
    // N7a (whole-branch review): the Category select must actually be
    // TOUCHED — selecting a real category, then selecting the overall
    // option back — so this exercises the `"" -> null` translation
    // (AddBudgetForm's own `onChange`) rather than merely reading the
    // select's untouched initial state, which would pass just as well for
    // a regression that submitted the bare (never-translated) empty string.
    const user = userEvent.setup();
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    await user.selectOptions(screen.getByLabelText("Category"), "groceries");
    await user.selectOptions(screen.getByLabelText("Category"), "");
    await user.type(screen.getByLabelText("Budget amount"), "600");
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    expect(setBudget).toHaveBeenCalled();
    expect(vi.mocked(setBudget).mock.calls[0]![0]).toBeNull();
  });

  it("submits the selected category and the checked wallets when creating a category budget", async () => {
    const user = userEvent.setup();
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    await user.selectOptions(screen.getByLabelText("Category"), "groceries");
    await user.click(screen.getByRole("checkbox", { name: "Savings" })); // uncheck Savings
    await user.type(screen.getByLabelText("Budget amount"), "600");
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    expect(setBudget).toHaveBeenCalled();
    expect(vi.mocked(setBudget).mock.calls[0]![0]).toBe("groceries");
    const formData = vi.mocked(setBudget).mock.calls[0]![2] as FormData;
    expect(formData.getAll("walletIds")).toEqual(["w1"]);
  });
});

describe("BudgetList — select all / clear all in the wallet picker", () => {
  const wallets = [
    { id: "w1", name: "Everyday", currency_code: "SGD" },
    { id: "w2", name: "Savings", currency_code: "SGD" },
  ];
  const categories = [{ key: "groceries", label: "Groceries" }];

  it("selects every wallet when pressed with some unchecked", async () => {
    const user = userEvent.setup();
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    await user.click(screen.getByRole("checkbox", { name: "Savings" })); // uncheck Savings
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("checkbox", { name: "Everyday" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Savings" })).toBeChecked();
  });

  it("clears every wallet when pressed with all checked", async () => {
    const user = userEvent.setup();
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByRole("checkbox", { name: "Everyday" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Savings" })).not.toBeChecked();
  });

  // Documentation, not a guard. Review of 666f53f established by mutation that
  // this test has no unique breaker and cannot be given one: its preconditions
  // are the opening lines of "selects every wallet", and its assertion is a
  // subset of "flips back to Select all". Every mutation that fails it — the
  // label strings swapped, `onChange` never deleting, `.every` weakened to
  // `.some` — fails one of those two first. Kept because the plan names it and
  // it reads as a clear statement of the rule; do not mistake it for coverage.
  it("reads Select all when one or more wallets are unchecked", async () => {
    const user = userEvent.setup();
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    await user.click(screen.getByRole("checkbox", { name: "Savings" })); // uncheck Savings
    expect(screen.getByRole("button", { name: "Select all" })).toBeInTheDocument();
  });

  it("flips the label back to Select all after unchecking one of every wallet", async () => {
    const user = userEvent.setup();
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    // Starts all-checked, so the button starts as "Clear all".
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Everyday" })); // uncheck Everyday
    expect(screen.getByRole("button", { name: "Select all" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("renders no select-all button when there are no primary-currency wallets", () => {
    render(<BudgetList rows={[]} />);
    expect(screen.queryByRole("button", { name: "Select all" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("contributes one walletIds value per wallet to FormData after Select all", async () => {
    const user = userEvent.setup();
    render(<BudgetList rows={[]} wallets={wallets} primaryCurrency="SGD" categories={categories} />);
    await user.click(screen.getByRole("checkbox", { name: "Savings" })); // uncheck Savings
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.selectOptions(screen.getByLabelText("Category"), "groceries");
    await user.type(screen.getByLabelText("Budget amount"), "600");
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    expect(setBudget).toHaveBeenCalled();
    const formData = vi.mocked(setBudget).mock.calls[0]![2] as FormData;
    expect(formData.getAll("walletIds")).toEqual(["w1", "w2"]);
  });
});

describe("BudgetList — coverage disclosures", () => {
  it("discloses, in text, when a budget does not cover every wallet in its own currency", () => {
    render(
      <BudgetList
        rows={[row({ wallet_names: ["Everyday"], wallet_count: 1 })]}
        wallets={[
          { id: "w1", name: "Everyday", currency_code: "SGD" },
          { id: "w2", name: "Savings", currency_code: "SGD" },
        ]}
        primaryCurrency="SGD"
      />,
    );
    // Not a bare /Savings/ match: the always-mounted new-budget wallet
    // picker below also renders a "Savings" checkbox label, which would
    // make an unscoped match ambiguous.
    expect(screen.getByText(/Doesn.t cover Savings/)).toBeInTheDocument();
  });

  it("discloses, in text, when wallets in another currency are excluded entirely", () => {
    render(
      <BudgetList
        rows={[row({ wallet_names: ["Everyday"], wallet_count: 1 })]}
        wallets={[
          { id: "w1", name: "Everyday", currency_code: "SGD" },
          { id: "w3", name: "Yen account", currency_code: "JPY" },
        ]}
        primaryCurrency="SGD"
      />,
    );
    // Minor fix-round finding: pin the FULL sentence, not a bare /JPY/ — a
    // bare match would pass under any rewording that merely mentions the
    // currency code somewhere.
    expect(
      screen.getByText("Wallets in JPY aren’t covered by any budget here."),
    ).toBeInTheDocument();
  });
});

describe("BudgetList — empty state", () => {
  it("says so when there is nothing to show", () => {
    render(<BudgetList rows={[]} />);
    expect(screen.getByText(/no spending or budgets recorded/i)).toBeInTheDocument();
  });
});
