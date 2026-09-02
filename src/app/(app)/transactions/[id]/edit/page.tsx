import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { TransactionForm, type EditSeed } from "@/components/TransactionForm";
import type { Category } from "@/components/CategoryPicker";
import { formatAmountInput, minorUnitFor } from "@/lib/money";

const uuid = z.uuid();

/**
 * /transactions/[id]/edit — Task 6's edit-transaction screen, the entry
 * point `TransactionList.tsx`'s row label now links to.
 *
 * `params` is a `Promise<{ id: string }>` in this Next version (confirmed
 * against node_modules/next/dist/docs/01-app/01-getting-started/
 * 03-layouts-and-pages.md, the same citation `/wallets/[id]/page.tsx`
 * already makes for its own dynamic segment).
 *
 * ## `id` is user-supplied; RLS is the only membership check, and this page
 * 404s the way `/wallets/[id]` does
 *
 * Exactly that page's own convention, reused rather than reinvented: every
 * read below is scoped through `transactions_member`/`wallets_select` RLS
 * (`is_wallet_member`, supabase/migrations/0004_rls.sql) — no separate,
 * hand-rolled membership check alongside it, since two checks that must
 * independently agree are how they drift apart. `.maybeSingle()`, not
 * `.single()`, for the same reason `/wallets/[id]/page.tsx`'s own doc
 * comment gives: `.single()` treats zero rows as an ERROR, forcing this
 * code to distinguish "a genuine query failure" from "RLS filtered this row
 * out" by string-matching an error code. `id` is validated as a UUID shape
 * BEFORE it ever reaches a query, the identical `z.uuid()` reuse that
 * page's own doc comment explains. `renderNotFound()` collapses THREE
 * inputs — doesn't exist, exists but not mine, not even a UUID — onto one
 * rendered output, and a FOURTH here that page doesn't have: a soft-deleted
 * row. `updateTransaction`/`updateTransfer` (src/server/actions/
 * transactions.ts) both filter `.is("deleted_at", null)` on their own
 * pre-flight lookups — "editing a transaction that's been deleted" is not
 * an offered action anywhere in this app (that action's own doc comment: a
 * deleted row must be restored first) — so this page's own lookups filter
 * it too, and a deleted id renders the identical not-found state rather
 * than a form whose Save could never succeed.
 *
 * Not `notFound()` (`next/navigation`): same reasoning
 * `/wallets/[id]/page.tsx`'s `WalletNotFound` doc comment gives — that
 * throws by design, which is right for a route with genuinely nothing to
 * render, but this task calls for a state that RENDERS (so it can be
 * exercised the same `await Page(...)` then `render(ui)` way every other
 * Server Component test in this codebase is) rather than only caught.
 *
 * ## Dispatching on the row's own `kind`, not on anything the caller states
 *
 * The loaded row's `kind` decides everything below it — which further rows
 * this page fetches, and which `EditSeed` variant (`TransactionForm.tsx`)
 * it hands to the form — mirroring `updateTransaction`'s own refusal of a
 * transfer id rather than ever risking a mismatch between what this page
 * renders and what the action underneath it will accept.
 *
 * A transfer's `transfer_id` links exactly two rows (`create_transfer`,
 * supabase/migrations/0005_transfer_fn.sql, always mints a fresh one) — its
 * own wallet(s) and both legs' amounts are loaded the same way
 * `updateTransfer`'s own pre-flight lookup does (`.eq("transfer_id",
 * ...).is("deleted_at", null)`, then which leg is "out" vs "in" read from
 * each row's OWN current sign, never guessed from array order): if the
 * caller's membership on one of the two wallets has changed since the
 * transfer was created, RLS makes only one leg visible here, and this page
 * refuses exactly like `updateTransfer` itself does for the identical
 * "incomplete pair" case, rather than rendering a form for half a transfer.
 *
 * ## The categories list may need one row beyond the "active" set
 *
 * Unlike `/transactions/new`, which only ever offers CREATING against an
 * active category, an existing transaction may already reference one
 * that's since been archived (`updateTransaction` itself still accepts
 * re-submitting the SAME category unchanged — only a newly *chosen*
 * archived category is refused; see that action's own doc comment). Fetched
 * separately and merged in when the wallet's active-category query didn't
 * already include it, so the picker/chip can still show and preselect the
 * transaction's real category rather than silently rendering "Choose
 * category" for a row that has one.
 *
 * ## `?from` — where a successful save returns to
 *
 * Fix round 1, Minor 1. `TransactionList` appends `?from=<identifier>` to a
 * row's edit link on any screen with a home more specific than the global
 * list (today: the wallet detail page). It is an origin IDENTIFIER
 * (`wallet:<uuid>`), NOT a path or a URL, it is untrusted (it comes straight
 * off the query string), and it is never parsed here — it is threaded
 * unmodified into `TransactionForm`, which is the only consumer, via
 * `parseOrigin` (`@/lib/origin`). That function never returns its input: it
 * matches a shape, validates the id, and BUILDS the path itself, which is
 * what keeps a query param from becoming an open redirect. An absent or
 * unrecognised `from` falls back to "/transactions", the destination this
 * page's saves already used.
 */
export default async function EditTransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * `string | string[] | undefined`, not just `string` — the identical
   * gotcha `/transactions/new/page.tsx`'s own doc comment writes up (review
   * round 1, fix 1 there). A `string`-only annotation is never actually
   * checked: Next's generated page-prop validator widens with `& any`
   * (.next/types/validator.ts), while its generated route type is
   * `Record<string, string | string[] | undefined>` (.next/types/routes.d.ts).
   * A URL with a repeated param (`?from=a&from=b`) really does deliver a
   * `string[]` at runtime, and an unnormalised array reaching `parseOrigin`
   * threw `from.split is not a function` inside TransactionForm's post-save
   * transition — AFTER the save had already succeeded, so the row was
   * written but the user landed on an error boundary instead of the
   * redirect. Normalised to the first value at this page boundary, exactly
   * as that page does; `src/lib/origin.ts` stays untouched.
   */
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { id } = await params;
  const { from: fromParam } = await searchParams;
  const from = Array.isArray(fromParam) ? fromParam[0] : fromParam;

  if (!uuid.safeParse(id).success) {
    return <TransactionNotFound />;
  }

  const supabase = await createClient();

  type TxnRow = {
    id: string;
    kind: "expense" | "income" | "transfer";
    wallet_id: string;
    amount_minor: number;
    currency_code: string;
    category_id: string | null;
    occurred_on: string;
    note: string | null;
    merchant: string | null;
    transfer_id: string | null;
  };

  const { data, error: rowError } = await supabase
    .from("transactions")
    .select(
      "id, kind, wallet_id, amount_minor, currency_code, category_id, occurred_on, note, merchant, transfer_id",
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  // A query ERROR is not "no rows" — every other Server Component read in
  // this codebase (`/wallets/[id]/page.tsx`, `/transactions/page.tsx`,
  // `/transactions/new/page.tsx`) draws the same distinction, and skipping
  // it here would render the not-found state on a transient DB blip,
  // indistinguishable from a genuinely absent/not-mine/deleted row.
  if (rowError) throw new Error("Failed to load transaction");

  const row = data as TxnRow | null;
  if (!row) {
    return <TransactionNotFound />;
  }

  if (row.kind === "transfer") {
    // `transfer_shape` (supabase/migrations/0003_transactions.sql) forces
    // every transfer row to carry a non-null `transfer_id` — this branch is
    // reachable only when `row.kind === "transfer"`, so `!row.transfer_id`
    // here would mean the schema's own CHECK constraint failed to hold, not
    // a state this page needs a distinct message for. Folded into the same
    // not-found rendering rather than a separate thrown error, matching
    // this page's own "collapse, don't distinguish" convention.
    if (!row.transfer_id) return <TransactionNotFound />;

    const { data: legs, error: legsError } = await supabase
      .from("transactions")
      .select("wallet_id, amount_minor, currency_code, occurred_on, note, merchant")
      .eq("transfer_id", row.transfer_id)
      .is("deleted_at", null);
    if (legsError) throw new Error("Failed to load transfer");

    // Exactly two, never fewer — see this file's own doc comment on partial
    // visibility, the same "incomplete pair -> not found" rule
    // `updateTransfer` itself applies.
    if (!legs || legs.length !== 2) return <TransactionNotFound />;

    // Which leg is "out" (the source) and which is "in" (the destination)
    // is read from each row's OWN sign, never array order — the identical
    // discipline `updateTransfer`'s own pre-flight lookup follows.
    const outLeg = legs.find((l) => l.amount_minor < 0);
    const inLeg = legs.find((l) => l.amount_minor > 0);
    if (!outLeg || !inLeg) return <TransactionNotFound />;

    const { data: legWallets, error: legWalletsError } = await supabase
      .from("wallets")
      .select("id, name, currency_code")
      .in("id", [outLeg.wallet_id, inLeg.wallet_id]);
    if (legWalletsError) throw new Error("Failed to load wallets");

    const fromWallet = legWallets?.find((w) => w.id === outLeg.wallet_id);
    const toWallet = legWallets?.find((w) => w.id === inLeg.wallet_id);
    // Both wallets are known to exist (a transaction's `wallet_id` FK
    // guarantees it) and be visible (the legs lookup above already proved
    // membership via `transactions_member`, which requires membership on
    // that same wallet) — this is a type-safety net against Supabase's
    // loosely-typed response, not a reachable branch in practice, mirroring
    // `/wallets/[id]/page.tsx`'s identical non-null assertions elsewhere.
    if (!fromWallet || !toWallet) throw new Error("Failed to load wallets");

    const edit: EditSeed = {
      kind: "transfer",
      transferId: row.transfer_id,
      fromWalletId: fromWallet.id,
      toWalletId: toWallet.id,
      amountOut: formatAmountInput(Math.abs(outLeg.amount_minor), minorUnitFor(outLeg.currency_code)),
      amountIn: formatAmountInput(Math.abs(inLeg.amount_minor), minorUnitFor(inLeg.currency_code)),
      // Both legs are always written with the SAME date/note/merchant, in
      // one statement, by both `create_transfer` and `update_transfer_pair`
      // (single `on_date`/`p_note`/`p_merchant` parameters, never per-leg) —
      // the outgoing leg's own values are read here as representative of
      // the pair, not because the incoming leg's values are assumed
      // different.
      occurredOn: outLeg.occurred_on,
      note: outLeg.note ?? "",
      merchant: outLeg.merchant ?? "",
    };

    return (
      <>
        <h1 className="sr-only">Edit transfer</h1>
        <TransactionForm
          mode="edit"
          wallets={[fromWallet, toWallet]}
          categories={[]}
          edit={edit}
          from={from}
        />
      </>
    );
  }

  const { data: wallet, error: walletError } = await supabase
    .from("wallets")
    .select("id, name, currency_code")
    .eq("id", row.wallet_id)
    .maybeSingle();
  if (walletError) throw new Error("Failed to load wallet");
  // Same type-safety-net reasoning as the transfer branch's wallet lookup
  // above: the transaction row above already proved membership on this
  // exact wallet via `transactions_member` RLS.
  if (!wallet) return <TransactionNotFound />;

  const { data: activeCategories, error: categoriesError } = await supabase
    .from("categories")
    .select("id, name, kind, color_slot, icon, wallet_id")
    .eq("wallet_id", row.wallet_id)
    .is("archived_at", null);
  if (categoriesError) throw new Error("Failed to load categories");

  let categories: Category[] = (activeCategories ?? []) as Category[];

  // This transaction's OWN category may have been archived since it was
  // filed — still a legitimate, re-submittable value on an unchanged edit
  // (see this file's own doc comment) — so it is fetched and merged in
  // separately whenever the active-only query above didn't already include
  // it, rather than leaving the picker/chip unable to show or preselect it.
  if (row.category_id && !categories.some((c) => c.id === row.category_id)) {
    const { data: currentCategory, error: currentCategoryError } = await supabase
      .from("categories")
      .select("id, name, kind, color_slot, icon, wallet_id")
      .eq("id", row.category_id)
      .maybeSingle();
    if (currentCategoryError) throw new Error("Failed to load category");
    if (currentCategory) categories = [...categories, currentCategory as Category];
  }

  const edit: EditSeed = {
    kind: row.kind,
    id: row.id,
    walletId: row.wallet_id,
    amount: formatAmountInput(Math.abs(row.amount_minor), minorUnitFor(row.currency_code)),
    categoryId: row.category_id,
    occurredOn: row.occurred_on,
    note: row.note ?? "",
    merchant: row.merchant ?? "",
  };

  return (
    <>
      {/* sr-only, matching /transactions/new's identical reasoning (that
          page's own doc comment): no visible title so this form's content
          doesn't grow past what its own sticky-Save reachability budget
          already accounts for. */}
      <h1 className="sr-only">Edit transaction</h1>
      <TransactionForm
        mode="edit"
        wallets={[wallet]}
        categories={categories}
        edit={edit}
        from={from}
      />
    </>
  );
}

/**
 * The SAME rendered output whether `id` doesn't exist, exists but isn't the
 * caller's, isn't even UUID-shaped, or names a soft-deleted row — collapsing
 * every one of those into one state is what keeps this from leaking which
 * of them actually happened, the identical binding rule
 * `/wallets/[id]/page.tsx`'s own `WalletNotFound` doc comment states (see
 * this file's own doc comment above for why `notFound()` isn't used here
 * either).
 */
function TransactionNotFound() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Transaction not found
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--ink-2)" }}>
        This transaction doesn’t exist or you don’t have access to it.
      </p>
    </div>
  );
}
