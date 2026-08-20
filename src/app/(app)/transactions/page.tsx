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
 * The same RPC result also gives the per-wallet member COUNT needed to
 * decide `showAttribution` (`TransactionList`'s prop): attribution renders
 * only in wallets with more than one member — in a solo wallet, "added by
 * you" on every single row is pure noise, not information (see
 * `TransactionList.tsx`'s own doc comment on the prop). `showAttribution`
 * here is a single page-level boolean (true if ANY wallet among the loaded
 * rows is shared), not computed per-row/per-wallet, matching the interface
 * the brief and `TransactionList`'s tests fix.
 *
 * `created_by` is `on delete set null` (0003) — a departed account leaves
 * its past rows with a NULL author rather than deleting ledger history.
 * The map below guards on `r.created_by` before ever looking it up, so
 * those rows resolve straight to `created_by_name: null` (same result as a
 * lookup miss would give), which `TransactionList` renders as no
 * attribution segment at all — never "added by" with nothing after it.
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

  // Keyed `wallet_id:user_id` -> display_name, so the same person's name
  // resolves independently per wallet (a display name is per-profile, not
  // per-membership, but keying this way costs nothing and avoids ever
  // conflating two different wallets' membership sets).
  const nameByWalletAndUser = new Map(
    memberRows.map((m) => [`${m.wallet_id}:${m.user_id}`, m.display_name]),
  );

  // A wallet is "shared" (attribution-eligible) once a SECOND distinct
  // user_id shows up for it — mirrors the brief's counting approach.
  const memberCountByWalletId = new Map<string, number>();
  for (const m of memberRows) {
    memberCountByWalletId.set(m.wallet_id, (memberCountByWalletId.get(m.wallet_id) ?? 0) + 1);
  }
  const sharedWalletIds = new Set(
    [...memberCountByWalletId.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );

  const joined = (data ?? []) as unknown as JoinedTxn[];

  const rows: Row[] = joined.map((r) => ({
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
    created_by_name: r.created_by
      ? (nameByWalletAndUser.get(`${r.wallet_id}:${r.created_by}`) ?? null)
      : null,
  }));

  // Page-level, not per-row: true as soon as ANY wallet among the loaded
  // rows has more than one member. `TransactionList` takes a single boolean
  // (see its own doc comment / this task's tests), not a per-row flag.
  const showAttribution = joined.some((r) => sharedWalletIds.has(r.wallet_id));

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="p-4 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Transactions
      </h1>
      <TransactionList rows={rows} showAttribution={showAttribution} />
    </div>
  );
}
