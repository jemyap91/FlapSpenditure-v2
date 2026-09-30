/**
 * The SAME rendered output whether `id` doesn't exist, exists but isn't the
 * caller's, isn't even UUID-shaped, or names a soft-deleted row — collapsing
 * every one of those into one state is what keeps this from leaking which
 * of them actually happened, the identical binding rule
 * `/wallets/[id]/page.tsx`'s own `WalletNotFound` doc comment states (see
 * page.tsx's doc comment for why `notFound()` isn't used here
 * either). Its own file so RefundEditSection can render the same state when
 * the refund disappears between the page's read and its own.
 */
export function TransactionNotFound() {
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
