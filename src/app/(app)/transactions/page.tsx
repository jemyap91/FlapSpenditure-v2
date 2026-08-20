import { createClient } from "@/lib/supabase/server";
import { TransactionList, type Row } from "@/components/TransactionList";

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
 */
export default async function TransactionsPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, kind, amount_minor, currency_code, occurred_on, note, wallets(name), categories!transactions_category_id_fkey(name, color_slot, icon)",
    )
    .is("deleted_at", null)
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  // A query error is not "no transactions" — src/app/(app)/layout.tsx's
  // own wallet-count check (and every other Server Component read in this
  // codebase) already documents why this distinction matters: on error,
  // `data` comes back null exactly like a legitimate empty result would,
  // so skipping this check would render the "no transactions yet" empty
  // state on a transient DB blip, indistinguishable from a real
  // brand-new-wallet state. Thrown, not swallowed, so the nearest error
  // boundary handles it instead.
  if (error) throw new Error("Failed to load transactions");

  // Supabase types embedded relations loosely. Assert the shape ONCE here,
  // at the data boundary, rather than casting inside the map.
  type JoinedTxn = {
    id: string;
    kind: Row["kind"];
    amount_minor: number;
    currency_code: string;
    occurred_on: string;
    note: string | null;
    wallets: { name: string } | null;
    categories: { name: string; color_slot: number; icon: string } | null;
  };

  const rows: Row[] = ((data ?? []) as unknown as JoinedTxn[]).map((r) => ({
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
  }));

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="p-4 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Transactions
      </h1>
      <TransactionList rows={rows} />
    </div>
  );
}
