import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { TransactionForm } from "@/components/TransactionForm";
import type { Category } from "@/components/CategoryPicker";

const uuid = z.uuid();

/**
 * /transactions/new — Task 19's add-transaction screen. A Server Component
 * that only fetches wallets/categories and hands them to the Client
 * Component (TransactionForm) as serializable props, the same
 * Server-Component-wraps-Client-Component split already used by
 * src/app/(auth)/login/page.tsx + login-form.tsx and src/app/onboarding/
 * page.tsx + onboarding-form.tsx, per node_modules/next/dist/docs/01-app/
 * 01-getting-started/05-server-and-client-components.md.
 *
 * `createClient`, not `createServerClient` — src/lib/supabase/server.ts's
 * own doc comment explains why: `createServerClient` is `@supabase/ssr`'s
 * own export, already imported unaliased by src/lib/supabase/middleware.ts,
 * so this project's server-side factory was deliberately renamed to avoid
 * the collision. Every other Server Component/Action in this codebase
 * (src/app/(app)/layout.tsx, src/app/(app)/categories/page.tsx,
 * src/server/actions/*.ts) already imports `createClient`.
 *
 * Both queries filter `.is("archived_at", null)`, the same convention
 * src/app/(app)/categories/page.tsx and src/server/actions/transactions.ts
 * both already follow: an archived wallet/category must not be offered as
 * a destination for a *new* transaction, even though the server actions
 * independently re-check this (defense in depth, not the only gate).
 *
 * The categories query is deliberately UNFILTERED by wallet: categories
 * belong to a wallet, not a user (0008), and `categories_member` RLS
 * already scopes this SELECT to every wallet the caller belongs to — so
 * this single query returns every wallet's categories at once, tagged with
 * `wallet_id`. TransactionForm filters that combined list down to the
 * currently-selected wallet client-side (its `walletCategories`), so
 * switching the wallet chip needs no refetch.
 */
export default async function NewTransactionPage({
  searchParams,
}: {
  /**
   * Task 4 (wallet-detail plan): two optional params, both user-supplied
   * and both untrusted.
   *
   * `wallet` PRESELECTS a wallet in the form; it does not AUTHORISE
   * anything — see the validation below, right where it is consumed
   * against this page's own already-RLS-scoped `wallets` query.
   *
   * `from` is an origin IDENTIFIER (`wallet:<uuid>`), not a path — it is
   * threaded straight through to TransactionForm unmodified and is never
   * parsed here. `TransactionForm` is the only place it is consumed, via
   * `parseOrigin` (`@/lib/origin`) — see that component's own doc comment
   * for why nothing else may turn it into a navigation target.
   */
  searchParams: Promise<{ wallet?: string; from?: string }>;
}) {
  const { wallet, from } = await searchParams;
  const supabase = await createClient();
  const [
    { data: wallets, error: walletsError },
    { data: categories, error: categoriesError },
  ] = await Promise.all([
    supabase
      .from("wallets")
      .select("id, name, currency_code")
      .is("archived_at", null)
      .order("created_at"),
    supabase
      .from("categories")
      .select("id, name, kind, color_slot, icon, wallet_id")
      .is("archived_at", null)
      .order("kind")
      .order("sort_order"),
  ]);

  // A query error is not "no wallets"/"no categories" — src/app/(app)/
  // layout.tsx's own doc comment on its wallet-count check spells out why
  // this distinction matters: on error, `data` comes back null/empty just
  // like a legitimate empty result would, so skipping this check would
  // send a user to /onboarding (wallets) or render a picker with no
  // categories at all (categories) on a transient DB blip, indistinguishable
  // from a real first-time state. Thrown, not redirected — let the nearest
  // error boundary handle it, matching that file's and
  // src/app/(app)/categories/page.tsx's identical reasoning.
  if (walletsError) throw new Error("Failed to load wallets");
  if (categoriesError) throw new Error("Failed to load categories");

  // Belt-and-suspenders with src/app/(app)/layout.tsx's own wallet-count
  // gate, which already redirects here before this page can render for a
  // wallet-less account — see that file's doc comment for why /onboarding
  // being a sibling of the (app) route group (not nested inside it) is
  // what keeps this redirect from looping.
  if (!wallets?.length) redirect("/onboarding");

  // `wallet` preselects but does not authorise (Task 4's controller
  // addendum, binding): validated as a uuid, then matched only against
  // THIS page's own already-RLS-scoped `wallets` query above — a wallet
  // the caller is not a member of is simply absent from that list, so this
  // one `.find` collapses "not a uuid", "well-formed uuid but doesn't
  // exist", and "exists but isn't mine" into the identical silent
  // fallback, no distinguishable error for any of them. Same three-
  // inputs-one-outcome shape src/app/(app)/wallets/[id]/page.tsx already
  // uses for its own not-found state, applied here to a fallback instead
  // of a rendered error.
  const requestedWalletId =
    wallet && uuid.safeParse(wallet).success ? wallets.find((w) => w.id === wallet)?.id : undefined;

  return (
    <>
      {/* This screen had no level-one heading, so its outline started at
          the `<h2>`-less form itself (caught by axe's `page-has-heading-one`
          in e2e/ledger.spec.ts). `sr-only` rather than a visible title:
          `sr-only` is absolutely positioned and so adds no layout height,
          which matters here specifically — TransactionForm's own comment
          records this form's mobile content already measuring ~1088px on a
          390x844 viewport, with the sticky Save button's reachability
          (spec §5.1) the thing that broke last time height grew. A visible
          title would push every control down for no information a user of
          this screen doesn't already have from the TabBar's own "Add". */}
      <h1 className="sr-only">New transaction</h1>
      <TransactionForm
        wallets={wallets}
        categories={categories ?? ([] satisfies Category[])}
        defaultWalletId={requestedWalletId ?? wallets[0]!.id}
        from={from}
      />
    </>
  );
}
