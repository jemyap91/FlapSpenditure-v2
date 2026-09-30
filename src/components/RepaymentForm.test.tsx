import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { createRefund, updateTransaction, refresh, push } = vi.hoisted(() => ({
  createRefund: vi.fn(),
  updateTransaction: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));
vi.mock("@/server/actions/refunds", () => ({ createRefund }));
vi.mock("@/server/actions/transactions", () => ({ updateTransaction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));

import { RepaymentForm } from "./RepaymentForm";

const EXPENSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const wallets = [
  { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Card" },
  { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Bank" },
];
const defaults = { walletId: wallets[0]!.id, amount: "", occurredOn: "2026-10-02", note: "" };

beforeEach(() => vi.clearAllMocks());

describe("RepaymentForm (create)", () => {
  it("records a repayment, clears the amount and stays open", async () => {
    createRefund.mockResolvedValue({ id: "r1" });
    render(<RepaymentForm mode={{ kind: "create", expenseId: EXPENSE }} wallets={wallets} defaults={defaults} />);
    await userEvent.selectOptions(screen.getByLabelText("Repayment wallet"), "Bank");
    await userEvent.type(screen.getByLabelText("Repayment amount"), "5");
    await userEvent.type(screen.getByLabelText("Repayment note"), "Alice");
    await userEvent.click(screen.getByRole("button", { name: "Record repayment" }));

    expect(createRefund).toHaveBeenCalledWith({
      refund_of: EXPENSE,
      wallet_id: wallets[1]!.id,
      amount: "5",
      occurred_on: "2026-10-02",
      note: "Alice",
      merchant: null,
    });
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByLabelText("Repayment amount")).toHaveValue("");
    expect(screen.getByLabelText("Repayment note")).toHaveValue("");
  });

  it("shows the action's error and keeps what was typed", async () => {
    createRefund.mockResolvedValue({ error: "A repayment must be in the same currency as its expense." });
    render(<RepaymentForm mode={{ kind: "create", expenseId: EXPENSE }} wallets={wallets} defaults={defaults} />);
    await userEvent.type(screen.getByLabelText("Repayment amount"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Record repayment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("same currency");
    expect(screen.getByLabelText("Repayment amount")).toHaveValue("5");
  });
});

describe("RepaymentForm (edit)", () => {
  it("saves through updateTransaction with no category and returns to the expense", async () => {
    updateTransaction.mockResolvedValue({ ok: true });
    render(
      <RepaymentForm
        mode={{ kind: "edit", id: "r1", expenseId: EXPENSE }}
        wallets={wallets}
        defaults={{ ...defaults, amount: "5.00", note: "Alice" }}
      />,
    );
    await userEvent.clear(screen.getByLabelText("Repayment amount"));
    await userEvent.type(screen.getByLabelText("Repayment amount"), "6");
    await userEvent.click(screen.getByRole("button", { name: "Save repayment" }));
    expect(updateTransaction).toHaveBeenCalledWith({
      id: "r1",
      wallet_id: wallets[0]!.id,
      amount: "6",
      occurred_on: "2026-10-02",
      category_id: null,
      note: "Alice",
      merchant: null,
    });
    expect(push).toHaveBeenCalledWith(`/transactions/${EXPENSE}/edit`);
  });
});
