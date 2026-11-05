import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/transactions",
}));

const { calls, selects, txRows } = vi.hoisted(() => ({
  calls: [] as [string, ...unknown[]][],
  selects: [] as string[],
  txRows: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: [], error: null }),
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["is", "or", "gte", "lte", "order", "limit", "eq", "filter"]) {
        builder[m] = (...args: unknown[]) => {
          if (table === "transactions") calls.push([m, ...args]);
          return builder;
        };
      }
      builder.select = (cols: string) => {
        if (table === "transactions") selects.push(cols);
        return builder;
      };
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({ data: table === "transactions" ? txRows : [], error: null, count: txRows.length });
      return builder;
    },
  }),
}));

import TransactionsPage from "./page";

const WALLET = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  calls.length = 0;
  selects.length = 0;
  txRows.length = 0;
});

describe("TransactionsPage channel filters", () => {
  it("selects channel and channel_mismatch", async () => {
    render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
    expect(selects[0]).toContain("channel, channel_mismatch");
  });

  it("applies wallet, mismatch and the date range together", async () => {
    render(
      await TransactionsPage({
        searchParams: Promise.resolve({ wallet: WALLET, mismatch: "1", from: "2026-09-01", to: "2026-09-30" }),
      }),
    );
    expect(calls).toContainEqual(["eq", "wallet_id", WALLET]);
    expect(calls).toContainEqual(["filter", "channel_mismatch", "eq", true]);
    expect(calls).toContainEqual(["gte", "occurred_on", "2026-09-01"]);
    expect(calls).toContainEqual(["lte", "occurred_on", "2026-09-30"]);
  });

  it("applies neither filter by default", async () => {
    render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
    expect(calls.some(([m]) => m === "eq" || m === "filter")).toBe(false);
  });

  it("renders No bonus and the channel for a flagged row", async () => {
    txRows.push({
      id: "t1", kind: "expense", amount_minor: -4250, currency_code: "SGD", occurred_on: "2026-09-02",
      note: null, merchant: "Uniqlo", created_by: null, wallet_id: WALLET,
      wallets: { name: "Woman's World" }, categories: null, repaid_expense: null,
      channel: "in_store", channel_mismatch: true,
    });
    render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/No bonus/)).toBeInTheDocument();
    expect(screen.getByText(/In store/)).toBeInTheDocument();
  });
});
