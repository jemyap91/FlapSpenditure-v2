import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { TransactionList, type Row } from "@/components/TransactionList";
import { resolveCreatedByNames, anyRowShared } from "../../transactions/attribution";
import { mergeWalletBalances, type WalletRow, type BalanceRow } from "../wallet-rows";
import { WalletFab } from "./WalletFab";

const uuid = z.uuid();

/**
 * /wallets/[id] — clicking a wallet's name on /wallets lands here (Task 3 of
 * the wallet-detail plan, WalletList.tsx's own doc comment). Scoped to ONE
 * wallet's balance and transaction history.
 *
 * `params` is a `Promise<{ id: string }>` in this Next version, not a plain
 * object — confirmed against node_modules/next/dist/docs/01-app/
 * 01-getting-started/03-layouts-and-pages.md's own dynamic-segment example
 * before writing this signature.
 *
 * ## `id` is user-supplied; RLS is the only membership check
 *
 * The controller addendum for this task is explicit: scope the query
 * through RLS exactly as every other read in this app does (`wallets_select`
 * — `is_wallet_member`, supabase/migrations/0004_rls.sql) and let a wallet
 * the caller cannot see return no rows. NOT a second, hand-rolled membership
 * check alongside it — two checks that must independently agree are how
 * they drift apart, and the RLS one is authoritative.
 *
 * `.maybeSingle()`, not `.single()`: `.single()` treats zero rows as an
 * ERROR (`PGRST116`), which would force this code to distinguish "a genuine
 * query failure" from "RLS filtered this row out" by string-matching an
 * error code — exactly the kind of leak-shaped branching the addendum warns
 * against. `.maybeSingle()` resolves zero rows to `{ data: null, error:
 * null }`, the same successful-empty-result shape a nonexistent id and a
 * not-mine id both produce, so `renderNotFound()` below is reached by ONE
 * path for both cases, not two paths that could disagree.
 *
 * `id` is validated as a UUID shape BEFORE it ever reaches a query,
 * deliberately reusing `zod`'s `z.uuid()` the same way `src/lib/origin.ts`
 * does (not duplicating that file's logic — this is a separate, simpler use
 * of the same schema). Without this, a malformed id (a stray path segment,
 * a bot probing `/wallets/../etc`) would reach Postgres as a literal and
 * come back as a `wallets` query ERROR ("invalid input syntax for type
 * uuid"), which this page would otherwise have to throw on rather than
 * render as the same not-found state everything else here collapses to.
 * Folding it into the not-found branch keeps that collapse total: THREE
 * inputs (doesn't exist / exists but not mine / not even a UUID) all reach
 * the identical rendered output.
 *
 * ## Reusing `TransactionList` rather than rebuilding a second list
 *
 * `src/app/(app)/transactions/page.tsx` already renders and filters
 * transactions, with money formatting, transfer From/To leg labelling, and
 * undo-based delete — this task's brief is explicit that scoping THAT to
 * one wallet is the job, not growing a parallel component that will drift.
 * This page therefore:
 *
 * - Adds `.eq("wallet_id", id)` to the same `transactions` select
 *   `page.tsx` already runs (`.is("deleted_at", null)`, the same
 *   `occurred_on`/`created_at` tie-break order, the same
 *   `categories!transactions_category_id_fkey` embed hint — see that
 *   file's own doc comment for why each of those is load-bearing).
 * - Drops the `wallets(name)` embed page.tsx needs (it lists MULTIPLE
 *   wallets' transactions and needs each row's own wallet name) — every row
 *   here is already known to belong to THIS wallet, whose name the page's
 *   own `<h1>` already states, so `wallet_name` is passed as `""` (review
 *   round 1, M2) rather than repeating it on every row; `TransactionList`'s
 *   secondary line already drops empty parts via `.filter(Boolean)`, so
 *   this needs no change to that shared component.
 * - Reuses `resolveCreatedByNames`/`anyRowShared` from
 *   `transactions/attribution.ts` UNCHANGED — both are already generic over
 *   `{ wallet_id, created_by }` rows, not tied to the multi-wallet page, so
 *   the exact per-row "is THIS row's wallet shared" gate that closed a
 *   Critical on that screen (see attribution.ts's own doc comment) applies
 *   here for free.
 * - Passes `listLabel`/`emptyMessage` overrides to `TransactionList` (new,
 *   optional props — see that component's own doc comment) rather than
 *   forking its markup, so this screen's pinned accessible name
 *   ("Transactions in <wallet name>") and empty-state copy ("No
 *   transactions in this wallet yet.") land without touching the shared
 *   money/transfer/delete logic at all.
 *
 * ## The balance
 *
 * Reuses `mergeWalletBalances` (`../wallet-rows.ts`, already unit-tested by
 * `wallet-rows.test.ts`) with a single-element array rather than
 * reimplementing its "missing balance row -> null, not 0" rule here.
 * `get_wallet_balances()` (supabase/migrations/0006_aggregates.sql) filters
 * `archived_at is null` server-side, so an ARCHIVED wallet's id is simply
 * absent from that RPC's result — `mergeWalletBalances` already treats a
 * missing id as "unknown" (`null`). Review round 1 (I3) caught that
 * rendering the bare em dash `WalletList.tsx` uses for THAT case here would
 * be wrong: an archived wallet's balance is perfectly computable, the RPC
 * just declines to, so "unknown" is the wrong word for it. This page
 * special-cases `balanceMinor === null && archived_at` to say so in text
 * ("Balance is not shown for archived wallets.") rather than reusing the
 * em dash's "we could not compute this" meaning for a different situation.
 *
 * ## The archived disclosure
 *
 * Stated in TEXT ("This wallet is archived, so new transactions can’t be
 * added to it."), not colour or a muted style alone — the controller
 * addendum's binding rule, and this codebase's general one (spec §6.4,
 * applied throughout TransactionList.tsx/WalletList.tsx already). The
 * "can't be added" half names the consequence a reader would otherwise
 * only discover by noticing the FAB's absence (review round 1, fix 4b) —
 * see the FAB guard's own comment below for the full reasoning.
 */
export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!uuid.safeParse(id).success) {
    return <WalletNotFound />;
  }

  const supabase = await createClient();

  type WalletDetailRow = {
    id: string;
    name: string;
    kind: WalletRow["kind"];
    currency_code: string;
    color_slot: number;
    icon: string;
    owner_id: string;
    archived_at: string | null;
  };

  const { data, error: walletError } = await supabase
    .from("wallets")
    .select("id, name, kind, currency_code, color_slot, icon, owner_id, archived_at")
    .eq("id", id)
    .maybeSingle();

  // A query ERROR is not "no rows" — every other Server Component read in
  // this codebase (transactions/page.tsx, wallets/page.tsx,
  // (app)/layout.tsx) draws the same distinction, and skipping it here would
  // render the not-found state on a transient DB blip, indistinguishable
  // from a genuinely absent/not-mine wallet. Thrown, not swallowed.
  if (walletError) throw new Error("Failed to load wallet");

  const walletRow = data as WalletDetailRow | null;
  if (!walletRow) {
    return <WalletNotFound />;
  }

  const [
    { data: balances, error: balancesError },
    { data: txRows, error: txError },
    { data: members, error: membersError },
  ] = await Promise.all([
    supabase.rpc("get_wallet_balances"),
    supabase
      .from("transactions")
      .select(
        "id, kind, amount_minor, currency_code, occurred_on, note, created_by, wallet_id, categories!transactions_category_id_fkey(name, color_slot, icon)",
      )
      .eq("wallet_id", id)
      .is("deleted_at", null)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.rpc("get_wallet_members"),
  ]);

  if (balancesError) throw new Error("Failed to load balances");
  if (txError) throw new Error("Failed to load transactions");
  if (membersError) throw new Error("Failed to load wallet members");

  // `mergeWalletBalances` maps 1:1 over its input array (see its own doc
  // comment), so a single-element input always yields a single-element
  // output — the `!` states that, rather than a real possibility of
  // `undefined` here (TS can't see the 1:1 relationship through the map).
  const walletWithBalance = mergeWalletBalances(
    [walletRow as WalletRow],
    (balances ?? []) as BalanceRow[],
  )[0]!;

  // Supabase types embedded relations loosely — asserted ONCE here, at the
  // data boundary, matching transactions/page.tsx's own convention (see its
  // doc comment for why the `categories` embed needs the explicit
  // `!transactions_category_id_fkey` hint at the query above).
  type JoinedTxn = {
    id: string;
    kind: Row["kind"];
    amount_minor: number;
    currency_code: string;
    occurred_on: string;
    note: string | null;
    created_by: string | null;
    wallet_id: string;
    categories: { name: string; color_slot: number; icon: string } | null;
  };

  const memberRows = members ?? [];
  const joined = (txRows ?? []) as unknown as JoinedTxn[];
  const withNames = resolveCreatedByNames(joined, memberRows);

  const rows: Row[] = withNames.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount_minor: r.amount_minor,
    currency_code: r.currency_code,
    occurred_on: r.occurred_on,
    note: r.note,
    // Every row here is already scoped to THIS wallet, and the page's own
    // `<h1>` already says its name — `TransactionList`'s secondary line
    // joins non-empty parts with `.filter(Boolean)`, so an empty string
    // here (rather than `walletRow.name`, which is what page.tsx originally
    // passed) drops the redundant repetition ("Coffee · Everyday" under a
    // heading that already reads "Everyday") without needing any change to
    // that shared component (review-caught, M2).
    wallet_name: "",
    category_name: r.categories?.name ?? null,
    category_icon: r.categories?.icon ?? null,
    color_slot: r.categories?.color_slot ?? null,
    created_by_name: r.created_by_name,
  }));

  const showAttribution = anyRowShared(joined, memberRows);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        {walletRow.name}
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--ink-2)" }}>
        {walletRow.kind === "card" ? "Card" : "Bank"} · {walletRow.currency_code}
      </p>
      {walletRow.archived_at && (
        <p className="mt-1 text-sm" style={{ color: "var(--ink-2)" }}>
          This wallet is archived, so new transactions can’t be added to it.
        </p>
      )}
      {walletWithBalance.balanceMinor === null && walletRow.archived_at ? (
        // `get_wallet_balances()` (supabase/migrations/0006_aggregates.sql)
        // filters `archived_at is null`, so an archived wallet's balance is
        // ABSENT from that RPC's result — not because it can't be computed
        // (it's a starting balance plus a sum, same as any other wallet),
        // but because the RPC declines to. `wallet-rows.ts` documents `null`
        // as meaning "we did not compute this," deliberately distinct from a
        // real zero — rendering the bare em dash `WalletList.tsx` uses for
        // THAT case here would state a design decision (the RPC's own
        // filter) in the vocabulary of a compute failure (review-caught,
        // I3). Said in words instead. A wallet-scoped balance RPC, or moving
        // the `archived_at` filter to call sites, would let this line go
        // away — out of scope here: it touches `/wallets` and the
        // dashboard, both outside this task's no-SQL-changes boundary.
        <p className="mt-3 text-sm" style={{ color: "var(--ink-2)" }}>
          Balance is not shown for archived wallets.
        </p>
      ) : (
        <p
          className="mt-3 text-2xl tabular-nums"
          style={{
            color:
              walletWithBalance.balanceMinor === null
                ? "var(--ink-2)"
                : walletWithBalance.balanceMinor < 0
                  ? "var(--neg)"
                  : "var(--ink)",
          }}
        >
          {walletWithBalance.balanceMinor === null
            ? "—"
            : formatMoney(walletWithBalance.balanceMinor, walletRow.currency_code)}
        </p>
      )}

      <div className="mt-6">
        <TransactionList
          rows={rows}
          showAttribution={showAttribution}
          listLabel={`Transactions in ${walletRow.name}`}
          emptyMessage="No transactions in this wallet yet."
        />
      </div>

      {/* Task 4 (wallet-detail plan): not offered on an archived wallet.
          The PRIMARY reason: `createTransaction`
          (src/server/actions/transactions.ts:104) rejects any transaction
          against an archived wallet outright — `if (!wallet ||
          wallet.archived_at) return { error: "Wallet not found" }` — so this
          button would be a dead end regardless of what it preselected.
          Secondarily, /transactions/new's own `wallets` query also excludes
          archived wallets (`.is("archived_at", null)`, that page's own doc
          comment), so this wallet's id would fail that page's membership
          check and silently preselect a DIFFERENT wallet instead. Either
          reason alone would be enough to hide the affordance rather than
          offer something that quietly does the wrong thing, with nothing on
          screen to explain why. */}
      {!walletRow.archived_at && <WalletFab walletId={walletRow.id} walletName={walletRow.name} />}
    </div>
  );
}

/**
 * The SAME rendered output whether `id` doesn't exist, exists but isn't the
 * caller's, or isn't even UUID-shaped — collapsing all three into one state
 * is what keeps this from leaking which of them actually happened (the
 * controller addendum's binding rule). Not `notFound()`
 * (`next/navigation`): that throws by design (`NEXT_HTTP_ERROR_FALLBACK;404`,
 * per node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
 * not-found.md), which is right for a route that genuinely has nothing to
 * render — but this task's brief asks for a state that RENDERS rather than
 * throws, and a component that throws can't be exercised the way every
 * other Server Component test in this codebase is (`await Page(...)` then
 * `render(ui)` — see budgets/page.test.tsx), only caught.
 */
function WalletNotFound() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Wallet not found
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--ink-2)" }}>
        This wallet doesn’t exist or you don’t have access to it.
      </p>
    </div>
  );
}
