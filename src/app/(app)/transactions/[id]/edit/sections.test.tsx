// src/app/(app)/transactions/[id]/edit/sections.test.tsx
//
// The two repayment sections the edit page delegates to (page.test.tsx
// stubs them out). Same fake-client idea as src/server/actions/
// refunds.test.ts, but the wallets read APPLIES the filters it is given
// rather than ignoring them: a fake that returned every wallet regardless
// would let a picker offer another household's wallet and still pass.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const SPACE = "88888888-8888-4888-8888-888888888888";
const OTHER_SPACE = "99999999-9999-4999-8999-999999999999";
const EXPENSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REFUND = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const { state } = vi.hoisted(() => ({
  state: {
    wallets: [] as { id: string; name: string; currency_code: string; space_id: string; archived_at: string | null }[],
    repayments: [] as unknown[],
    refundRow: null as unknown,
    hidden: 0,
    rpcCalls: [] as { fn: string; args: unknown }[],
  },
}));

vi.mock("@/components/RepaymentForm", () => ({
  RepaymentForm: (p: { wallets: { id: string; name: string }[] }) => (
    <ul data-testid="picker">
      {p.wallets.map((w) => (
        <li key={w.id}>{w.name}</li>
      ))}
    </ul>
  ),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      return { data: state.hidden, error: null };
    },
    from: (table: string) => {
      const eqs: Record<string, unknown> = {};
      const nulls: string[] = [];
      let single = false;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.order = () => b;
      b.eq = (col: string, v: unknown) => {
        eqs[col] = v;
        return b;
      };
      b.is = (col: string) => {
        nulls.push(col);
        return b;
      };
      b.maybeSingle = () => {
        single = true;
        return b;
      };
      b.then = (resolve: (v: unknown) => void) => {
        if (table === "wallets") {
          const rows = state.wallets.filter(
            (w) =>
              Object.entries(eqs).every(([k, v]) => (w as Record<string, unknown>)[k] === v) &&
              nulls.every((k) => (w as Record<string, unknown>)[k] === null),
          );
          return resolve({ data: rows.map(({ id, name }) => ({ id, name })), error: null });
        }
        if (table === "transactions") {
          return resolve({ data: single ? state.refundRow : state.repayments, error: null });
        }
        throw new Error(`unexpected table ${table}`);
      };
      return b;
    },
  }),
}));

import { RepaymentsSection } from "./RepaymentsSection";
import { RefundEditSection } from "./RefundEditSection";

beforeEach(() => {
  state.wallets = [
    { id: "w-home", name: "Home card", currency_code: "USD", space_id: SPACE, archived_at: null },
    { id: "w-away", name: "Other household bank", currency_code: "USD", space_id: OTHER_SPACE, archived_at: null },
  ];
  state.repayments = [];
  state.refundRow = null;
  state.hidden = 0;
  state.rpcCalls = [];
});

const repayments = () =>
  RepaymentsSection({ expenseId: EXPENSE, spaceId: SPACE, currencyCode: "USD", expenseMinor: -2500, defaultWalletId: "w-home" });

describe("RepaymentsSection", () => {
  it("offers only wallets in the expense's household", async () => {
    render(await repayments());
    expect(screen.getByText("Home card")).toBeInTheDocument();
    expect(screen.queryByText("Other household bank")).not.toBeInTheDocument();
  });

  it("says how many repayments sit in wallets the viewer cannot see", async () => {
    state.hidden = 1;
    const { unmount } = render(await repayments());
    expect(state.rpcCalls).toContainEqual({ fn: "count_hidden_repayments", args: { p_expense: EXPENSE } });
    expect(
      screen.getByText("Plus 1 repayment recorded in wallets you can’t see — ask the household member who recorded them."),
    ).toBeInTheDocument();
    unmount();

    state.hidden = 3;
    render(await repayments());
    expect(
      screen.getByText("Plus 3 repayments recorded in wallets you can’t see — ask the household member who recorded them."),
    ).toBeInTheDocument();
  });

  it("says nothing extra when every repayment is visible", async () => {
    render(await repayments());
    expect(screen.queryByText(/wallets you can’t see/)).not.toBeInTheDocument();
  });
});

describe("RefundEditSection", () => {
  it("offers only wallets in the repayment's household", async () => {
    state.refundRow = {
      id: REFUND,
      wallet_id: "w-home",
      space_id: SPACE,
      amount_minor: 500,
      currency_code: "USD",
      occurred_on: "2026-10-02",
      note: null,
      refund_of: EXPENSE,
      repaid_expense: { id: EXPENSE, occurred_on: "2026-09-30", merchant: "Dinner", note: null },
    };
    render(await RefundEditSection({ id: REFUND }));
    expect(screen.getByText("Home card")).toBeInTheDocument();
    expect(screen.queryByText("Other household bank")).not.toBeInTheDocument();
  });

  it("renders the page's not-found state when the row vanished since the page read it", async () => {
    const ui = await RefundEditSection({ id: REFUND });
    expect(ui).not.toBeNull();
    render(ui!);
    expect(screen.getByRole("heading", { name: "Transaction not found" })).toBeInTheDocument();
  });
});
