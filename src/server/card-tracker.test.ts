import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import { formatMoney } from "@/lib/money";
import { loadCardTracker, warningsFor } from "./card-tracker";

type Row = Record<string, unknown>;

const CITI = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function wallet(over: Row = {}): Row {
  return {
    id: CITI,
    name: "Citi Rewards",
    currency_code: "SGD",
    archived_at: null,
    bonus_channel: "online",
    cycle_start_day: 19,
    bonus_cap_minor: 100000,
    ...over,
  };
}

let n = 0;
function expense(over: Row = {}): Row {
  n += 1;
  return {
    id: `tx-${n}`,
    wallet_id: CITI,
    kind: "expense",
    deleted_at: null,
    occurred_on: "2026-11-05",
    amount_minor: 10000,
    channel: "online",
    ...over,
  };
}

/**
 * A fake that really applies the filters it is given, so a test passes
 * only if the query asked for the right rows -- not because the fixture
 * was pre-filtered.
 */
function fakeClient(db: {
  wallets: Row[];
  transactions: Row[];
  failing?: "wallets" | "transactions" | "transaction";
}) {
  return {
    from(table: "wallets" | "transactions") {
      let rows = [...db[table]];
      const keep = (test: (r: Row) => boolean) => {
        rows = rows.filter(test);
        return builder;
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => keep((r) => r[c] === v),
        neq: (c: string, v: unknown) => keep((r) => r[c] !== v),
        is: (c: string, v: unknown) => keep((r) => r[c] === v),
        not: (c: string, _op: string, v: unknown) => keep((r) => r[c] !== v),
        gte: (c: string, v: string) => keep((r) => (r[c] as string) >= v),
        lte: (c: string, v: string) => keep((r) => (r[c] as string) <= v),
        order: (c: string) => {
          rows.sort((a, b) => String(a[c]).localeCompare(String(b[c])));
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve(
            db.failing === "transaction" && table === "transactions"
              ? { data: null, error: { message: "boom" } }
              : { data: rows[0] ?? null, error: null },
          ),
        then: (resolve: (v: unknown) => void) =>
          resolve(
            db.failing === table
              ? { data: null, error: { message: "boom" } }
              : { data: rows, error: null },
          ),
      };
      return builder;
    },
  } as never;
}

const ON = { on: "2026-11-05", today: "2026-11-05" };

describe("loadCardTracker", () => {
  beforeEach(() => {
    n = 0;
  });

  it("totals the spend in the cycle containing `on`", async () => {
    const supabase = fakeClient({
      wallets: [wallet()],
      transactions: [
        expense({ occurred_on: "2026-10-19", amount_minor: 20000 }),
        expense({ occurred_on: "2026-11-05", amount_minor: 11000 }),
        expense({ occurred_on: "2026-10-18", amount_minor: 5000 }),
      ],
    });
    const [row] = await loadCardTracker(supabase, ON);
    expect(row).toMatchObject({
      walletId: CITI,
      walletName: "Citi Rewards",
      currency: "SGD",
      bonusChannel: "online",
      capMinor: 100000,
      from: "2026-10-19",
      to: "2026-11-18",
      spentMinor: 31000,
      remainingMinor: 69000,
      mismatchCount: 0,
    });
  });

  it("counts an off-channel expense as a mismatch, not as spend", async () => {
    const supabase = fakeClient({
      wallets: [wallet()],
      transactions: [expense({ channel: "in_store", amount_minor: 4000 })],
    });
    const [row] = await loadCardTracker(supabase, ON);
    expect(row).toMatchObject({ spentMinor: 0, mismatchCount: 1 });
  });

  it("counts a blank-channel expense as neither", async () => {
    const supabase = fakeClient({ wallets: [wallet()], transactions: [expense({ channel: null })] });
    const [row] = await loadCardTracker(supabase, ON);
    expect(row).toMatchObject({ spentMinor: 0, mismatchCount: 0 });
  });

  it("counts every expense on a min-spend card, whatever its channel, with no mismatches", async () => {
    const supabase = fakeClient({
      wallets: [wallet({ bonus_channel: null, bonus_cap_minor: 50000 })],
      transactions: [
        expense({ channel: "in_store", amount_minor: 3915 }),
        expense({ channel: "bill", amount_minor: 1000 }),
        expense({ channel: null, amount_minor: 1143 }),
      ],
    });
    const [row] = await loadCardTracker(supabase, ON);
    expect(row).toMatchObject({
      bonusChannel: null,
      spentMinor: 6058,
      remainingMinor: 43942,
      mismatchCount: 0,
    });
  });

  it("floors remaining at zero past the max while spent keeps the real total", async () => {
    const supabase = fakeClient({
      wallets: [wallet()],
      transactions: [expense({ amount_minor: 108000 })],
    });
    const [row] = await loadCardTracker(supabase, ON);
    expect(row).toMatchObject({ spentMinor: 108000, remainingMinor: 0, pace: "reached" });
  });

  it("sums the absolute amount of stored signed expenses", async () => {
    const supabase = fakeClient({
      wallets: [wallet()],
      transactions: [expense({ amount_minor: -2500 })],
    });
    const [row] = await loadCardTracker(supabase, ON);
    expect(row!.spentMinor).toBe(2500);
  });

  it("leaves out the excluded transaction", async () => {
    const keep = expense({ amount_minor: 3000 });
    const skip = expense({ amount_minor: 9000 });
    const supabase = fakeClient({ wallets: [wallet()], transactions: [keep, skip] });
    const [row] = await loadCardTracker(supabase, { ...ON, excludeTransactionId: skip.id as string });
    expect(row!.spentMinor).toBe(3000);
  });

  it("gives no row for an archived wallet or one with no max", async () => {
    const supabase = fakeClient({
      wallets: [
        wallet({ archived_at: "2026-10-01T00:00:00Z" }),
        wallet({ id: OTHER, name: "No Max", bonus_cap_minor: null }),
      ],
      transactions: [],
    });
    expect(await loadCardTracker(supabase, ON)).toEqual([]);
  });

  it("ignores deleted rows and non-expenses, and picks the expense back up when restored", async () => {
    const tx = expense({ amount_minor: 7000 });
    const income = expense({ kind: "income", amount_minor: 99000 });
    const db = { wallets: [wallet()], transactions: [tx, income] };
    expect((await loadCardTracker(fakeClient(db), ON))[0]!.spentMinor).toBe(7000);

    tx.deleted_at = "2026-11-05T01:00:00Z";
    expect((await loadCardTracker(fakeClient(db), ON))[0]!.spentMinor).toBe(0);

    tx.deleted_at = null;
    expect((await loadCardTracker(fakeClient(db), ON))[0]!.spentMinor).toBe(7000);
  });

  it("counts a moved expense only on its new wallet, by that wallet's channel", async () => {
    const tx = expense({ channel: "online", amount_minor: 6000 });
    const db = {
      wallets: [wallet(), wallet({ id: OTHER, name: "Zeta In Store", bonus_channel: "in_store" })],
      transactions: [tx],
    };
    let rows = await loadCardTracker(fakeClient(db), ON);
    expect(rows.map((r) => [r.walletName, r.spentMinor, r.mismatchCount])).toEqual([
      ["Citi Rewards", 6000, 0],
      ["Zeta In Store", 0, 0],
    ]);

    tx.wallet_id = OTHER;
    rows = await loadCardTracker(fakeClient(db), ON);
    expect(rows.map((r) => [r.walletName, r.spentMinor, r.mismatchCount])).toEqual([
      ["Citi Rewards", 0, 0],
      ["Zeta In Store", 0, 1],
    ]);
  });

  it("swaps which expenses count when the wallet's channel changes", async () => {
    const w = wallet();
    const db = {
      wallets: [w],
      transactions: [
        expense({ channel: "online", amount_minor: 1000 }),
        expense({ channel: "in_store", amount_minor: 2000 }),
      ],
    };
    let [row] = await loadCardTracker(fakeClient(db), ON);
    expect(row).toMatchObject({ spentMinor: 1000, mismatchCount: 1 });

    w.bonus_channel = "in_store";
    [row] = await loadCardTracker(fakeClient(db), ON);
    expect(row).toMatchObject({ spentMinor: 2000, mismatchCount: 1 });
  });
});

describe("loadCardTracker errors and pace", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rejects when the wallets read fails", async () => {
    const supabase = fakeClient({ wallets: [wallet()], transactions: [], failing: "wallets" });
    await expect(loadCardTracker(supabase, ON)).rejects.toThrow("Failed to load card tracker");
  });

  it("rejects when the expenses read fails", async () => {
    const supabase = fakeClient({ wallets: [wallet()], transactions: [], failing: "transactions" });
    await expect(loadCardTracker(supabase, ON)).rejects.toThrow("Failed to load card tracker");
  });

  it("passes opts.today to paceFor", async () => {
    const supabase = fakeClient({
      wallets: [wallet()],
      transactions: [expense({ amount_minor: 70000 })],
    });
    const [late] = await loadCardTracker(supabase, { on: "2026-11-05", today: "2026-11-05" });
    const [early] = await loadCardTracker(supabase, { on: "2026-11-05", today: "2026-10-19" });
    expect(late!.pace).toBe("on_pace");
    expect(early!.pace).toBe("under");
  });
});

describe("warningsFor", () => {
  beforeEach(() => {
    n = 0;
  });

  it("warns about the max for an on-channel expense and about the channel for an off-channel one", async () => {
    // expenseWarnings never raises both for one expense: only an on-channel
    // expense can pass the max.
    const prior = expense({ amount_minor: 95000 });
    const over = expense({ amount_minor: 10000, channel: "online" });
    const db = { wallets: [wallet()], transactions: [prior, over] };
    const res = await warningsFor(fakeClient(db), over.id as string);
    expect(res.channel).toBe("online");
    expect(res.warnings).toEqual([`This takes Citi Rewards past its ${formatMoney(100000, "SGD")} max for this cycle.`]);

    const wrong = expense({ amount_minor: 1000, channel: "in_store" });
    const res2 = await warningsFor(
      fakeClient({ wallets: [wallet()], transactions: [prior, wrong] }),
      wrong.id as string,
    );
    expect(res2).toEqual({
      channel: "in_store",
      warnings: ["Citi Rewards earns its bonus Online, so this won't earn it."],
    });
  });

  it("measures an expense against its own cycle and excludes itself from spent-before", async () => {
    // Own cycle is 2026-10-19..2026-11-18. Spend before it is 90000; itself
    // 10000 would double-count to 110000 if not excluded. 90000 + 10000 is
    // exactly the max, so no warning.
    const self = expense({ occurred_on: "2026-11-05", amount_minor: 10000 });
    const before = expense({ occurred_on: "2026-10-20", amount_minor: 90000 });
    const lastCycle = expense({ occurred_on: "2026-10-01", amount_minor: 50000 });
    const res = await warningsFor(
      fakeClient({ wallets: [wallet()], transactions: [self, before, lastCycle] }),
      self.id as string,
    );
    expect(res.warnings).toEqual([]);
  });

  it("gives no max warning for a wallet with no tracker row", async () => {
    const tx = expense({ amount_minor: 999999 });
    const res = await warningsFor(
      fakeClient({ wallets: [wallet({ bonus_cap_minor: null })], transactions: [tx] }),
      tx.id as string,
    );
    expect(res).toEqual({ channel: "online", warnings: [] });
  });

  it("rejects when the transaction read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tx = expense();
    await expect(
      warningsFor(
        fakeClient({ wallets: [wallet()], transactions: [tx], failing: "transaction" }),
        tx.id as string,
      ),
    ).rejects.toThrow("Failed to load warnings");
  });

  it("returns the empty result for a transaction that does not exist", async () => {
    expect(await warningsFor(fakeClient({ wallets: [wallet()], transactions: [] }), "nope")).toEqual({
      channel: null,
      warnings: [],
    });
  });

  it("warns for nothing but expenses", async () => {
    const tx = expense({ kind: "income" });
    const res = await warningsFor(fakeClient({ wallets: [wallet()], transactions: [tx] }), tx.id as string);
    expect(res).toEqual({ channel: null, warnings: [] });
  });
});
