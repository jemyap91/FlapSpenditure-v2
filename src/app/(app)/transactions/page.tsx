import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { TransactionList, type Row } from "@/components/TransactionList";
import { resolveCreatedByNames, anyRowShared } from "./attribution";

/**
 * /transactions — Task 20's full ledger review screen, and the route
 * Task 19's add-transaction screen now redirects to on save (see
 * TransactionForm.tsx's doc comment for that decision).
 *
 * `createClient`, not `createServerClient` (the brief's stale name) —
 * src/lib/supabase/server.ts's own doc comment explains the rename: this
 * project's server-side factory is deliberately not called
 * `createServerClient` to avoid colliding with `@supabase/ssr`'s own
 * export of that name, already imported unaliased by
 * src/lib/supabase/middleware.ts. Every other Server Component/Action in
 * this codebase (src/app/(app)/layout.tsx, src/app/(app)/categories/
 * page.tsx, src/app/(app)/transactions/new/page.tsx,
 * src/server/actions/*.ts) already imports `createClient`.
 *
 * `.is("deleted_at", null)` is not optional decoration — every ledger
 * query in this codebase filters it (this task's binding display rule),
 * and RLS does not do this filtering for you: `transactions_member`
 * (supabase/migrations/0004_rls.sql) scopes rows by wallet membership, not
 * by `deleted_at`, so a soft-deleted row is still visible to the same
 * policy that lets you see the live ones.
 *
 * `wallets(name)` / `categories!transactions_category_id_fkey(name,
 * color_slot, icon)` each resolve to a single embedded object, not an
 * array — `transactions` has exactly one FK to `wallets` (`wallet_id`) and
 * one *simple* FK to `categories` (`category_id` -> `categories.id`,
 * `transactions_category_id_fkey`), confirmed against `src/lib/
 * database.types.ts`'s generated `Relationships` (`isOneToOne: false` from
 * the `transactions` side, i.e. many transactions to one wallet/category —
 * PostgREST embeds the "one" side of a many-to-one as a single object).
 *
 * The `categories` embed needs the explicit `!transactions_category_id_fkey`
 * hint, unlike `wallets`: 0008's composite FK
 * `transactions_category_same_wallet` (`(category_id, wallet_id)` ->
 * `categories(id, wallet_id)`, added so a transaction can never reference a
 * category from a different wallet) gives `transactions` a SECOND
 * relationship to `categories`. An unqualified `categories(...)` is
 * ambiguous between the two and PostgREST rejects the whole query with
 * `PGRST201` ("more than one relationship was found") — confirmed live
 * against this branch's local Postgres — so every column here must resolve
 * through the plain `category_id` FK explicitly, not the composite one.
 *
 * `note` IS selected, and is rendered — `TransactionList` shows it as each
 * row's primary line, demoting the category to the secondary line beside
 * the wallet. It was excluded for a while on review, having been fetched
 * and carried into `Row` without anything displaying it (a dead payload on
 * every request); that comment said to add it back once something rendered
 * it, and that is now the case. Keep the two in step: if the note ever
 * stops being displayed, drop it from this select again.
 *
 * `.order("occurred_on", ...)` alone lets rows sharing a day reshuffle
 * between renders (Postgres makes no ordering promise among ties), which
 * would be visible as list-reordering after every `revalidatePath`/
 * `router.refresh()` a delete or undo triggers. `created_at desc` as a
 * secondary key gives same-day rows a stable, most-recent-first order.
 *
 * ## Attribution ("added by <name>") — Task 9
 *
 * `created_by_name` is deliberately NOT resolved via a `profiles` embed
 * (`profiles:created_by(display_name)`), even though `created_by` is a
 * plain uuid column and that embed syntax would look like it should work.
 * Two independent reasons it can't:
 *
 * 1. `transactions.created_by` has a foreign key to `auth.users(id)`
 *    (`supabase/migrations/0003_transactions.sql`), not to `profiles(id)`.
 *    PostgREST resolves embeds off declared FKs; there is no FK for it to
 *    walk from `transactions` to `profiles` at all, so the embed fails
 *    outright rather than silently returning null.
 * 2. Even a manual second query against `profiles` keyed by `created_by`
 *    would not help: `profiles_own` RLS (`supabase/migrations/0001_*.sql`)
 *    is `using (id = auth.uid())` — a user can read ONLY their own profile
 *    row. For every row some OTHER wallet member created, that query
 *    returns nothing. That is exactly the case attribution exists to
 *    serve, so it would look correct in single-user testing ("added by
 *    you") while silently rendering nameless for every co-member's row in
 *    production.
 *
 * `get_wallet_members()` (`supabase/migrations/
 * 0010_invite_and_member_visibility.sql`) is the SECURITY DEFINER RPC
 * `(app)/wallets/page.tsx` already uses to solve the identical
 * `wallet_members -> profiles` gap for the members list. It self-scopes to
 * wallets the caller belongs to and returns `wallet_id, user_id,
 * display_name, role` for every member of every such wallet — since a
 * transaction's `created_by` is, by definition, a member of that
 * transaction's wallet, this one RPC result covers every author this page
 * could possibly need to name, with no per-row query.
 *
 * Resolving `created_by_name` and deciding `showAttribution` both happen in
 * `./attribution.ts`, not inline here — extracted the same way
 * `(app)/wallets/wallet-rows.ts` extracts `mergeWalletBalances`, so the
 * logic is unit-testable without a Supabase stack (`attribution.test.ts`).
 *
 * PITFALL (round-1 review Critical, now fixed and regression-tested):
 * `get_wallet_members()` filters only on `is_wallet_member(wallet_id)` —
 * NO member-count threshold — so it returns a row for the caller's SOLO
 * wallets too, naming the caller as their own sole member. A page-level
 * "is ANY wallet on this page shared" boolean is fine for
 * `showAttribution` itself (it only asks whether attribution is even
 * worth considering at all), but `created_by_name` must be resolved PER
 * ROW against THAT row's own wallet — `resolveCreatedByNames` gates on
 * `sharedWalletIds.has(row.wallet_id)` before ever doing the name lookup,
 * so a solo-wallet row's `created_by_name` stays `null` even when the same
 * page also renders a genuinely shared wallet's transactions. Getting this
 * gate wrong (checking only "is created_by non-null", or checking
 * `showAttribution` page-wide instead of per row) is exactly how "added by
 * <you>" leaked onto private-wallet rows in round 1 — see
 * `attribution.ts`'s and `attribution.test.ts`'s own doc comments for the
 * full trace.
 *
 * `created_by` is `on delete set null` (0003) — a departed account leaves
 * its past rows with a NULL author rather than deleting ledger history.
 * `resolveCreatedByNames` guards on `r.created_by` before ever looking it
 * up, so those rows resolve straight to `created_by_name: null` (same
 * result the per-row shared-wallet gate above already gives), which
 * `TransactionList` renders as no attribution segment at all — never
 * "added by" with nothing after it.
 */
export default async function TransactionsPage() {
  const supabase = await createClient();
  const [{ data, error }, { data: members, error: membersError }] = await Promise.all([
    supabase
      .from("transactions")
      .select(
        "id, kind, amount_minor, currency_code, occurred_on, note, created_by, wallet_id, wallets(name), categories!transactions_category_id_fkey(name, color_slot, icon)",
      )
      .is("deleted_at", null)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.rpc("get_wallet_members"),
  ]);

  // A query error is not "no transactions" — src/app/(app)/layout.tsx's
  // own wallet-count check (and every other Server Component read in this
  // codebase) already documents why this distinction matters: on error,
  // `data` comes back null exactly like a legitimate empty result would,
  // so skipping this check would render the "no transactions yet" empty
  // state on a transient DB blip, indistinguishable from a real
  // brand-new-wallet state. Thrown, not swallowed, so the nearest error
  // boundary handles it instead. Same reasoning applies to the members RPC:
  // an error there must not silently degrade into "no attribution shown"
  // (which would be indistinguishable from every wallet genuinely being
  // solo) or "no author name resolved" (rows rendering nameless as if every
  // author had left).
  if (error) throw new Error("Failed to load transactions");
  if (membersError) throw new Error("Failed to load wallet members");

  // Supabase types embedded relations loosely. Assert the shape ONCE here,
  // at the data boundary, rather than casting inside the map.
  type JoinedTxn = {
    id: string;
    kind: Row["kind"];
    amount_minor: number;
    currency_code: string;
    occurred_on: string;
    note: string | null;
    created_by: string | null;
    wallet_id: string;
    wallets: { name: string } | null;
    categories: { name: string; color_slot: number; icon: string } | null;
  };

  const memberRows = members ?? [];
  const joined = (data ?? []) as unknown as JoinedTxn[];

  // Per-row author names, gated on EACH row's own wallet being shared — see
  // this file's own doc comment and attribution.ts's for why that gate has
  // to be per-row rather than page-wide.
  const withNames = resolveCreatedByNames(joined, memberRows);

  const rows: Row[] = withNames.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount_minor: r.amount_minor,
    currency_code: r.currency_code,
    occurred_on: r.occurred_on,
    note: r.note,
    wallet_name: r.wallets?.name ?? "",
    category_name: r.categories?.name ?? null,
    category_icon: r.categories?.icon ?? null,
    color_slot: r.categories?.color_slot ?? null,
    created_by_name: r.created_by_name,
  }));

  // Page-level: whether attribution is worth considering AT ALL for this
  // render. `TransactionList` takes a single boolean (see its own doc
  // comment / this task's tests) and combines it with each row's own
  // (already per-row-gated) `created_by_name`, so a `true` here does not by
  // itself put "added by" on every row — only on rows whose own
  // `created_by_name` survived `resolveCreatedByNames`' gate above.
  const showAttribution = anyRowShared(joined, memberRows);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between gap-3 p-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
          Transactions
        </h1>
        {/* /recurring's permanent home (Task 5's own brief): the
            dashboard's not-yet-built "due" list (Task 6) disappears
            whenever nothing is due, which is exactly when a user goes
            looking to CREATE a rule, so it cannot be the only entry point.
            A plain link, not a TabBar/Sidebar item — the mobile tab bar
            was just cut from six items to five to stop wallet names
            truncating. */}
        <Link
          href="/recurring"
          className="shrink-0 rounded-sm text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]"
          style={{ color: "var(--ink-2)" }}
        >
          Recurring
        </Link>
      </div>
      <TransactionList rows={rows} showAttribution={showAttribution} />
    </div>
  );
}
