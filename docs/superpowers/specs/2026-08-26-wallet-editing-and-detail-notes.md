# Wallet editing and wallet detail — captured, not yet designed

**Status:** REQUESTED 2026-08-26, queued behind the wallet-set budgets branch.
Not started. Captured so the requirements and the one hard question are not
re-derived later.

## What was asked for

> "The details for wallets like name, balance amount etc should be editable for
> the user. And when clicking into the wallet, it should show all its
> transactions with a filter"

Two features:

1. **Edit a wallet** — name, and "balance amount", and presumably currency.
2. **Wallet detail screen** — click a wallet, see its transactions, with a filter.

## The one question that changes the design

**Balance is not a stored field. It is derived.**

`get_wallet_balances` sums the wallet's transactions; there is no
`wallets.balance` column, by design — a ledger's balance is the consequence of
its entries. So "make the balance editable" cannot mean "write a new number
into a column" without breaking the invariant that the balance equals the sum
of what happened.

Three ways to give the user what they actually want:

- **(a) An adjustment transaction.** Editing the balance records a
  balance-correction entry for the difference, dated today, in a reserved
  category. The ledger stays true, the history explains itself, and the
  arithmetic still adds up. This is what accounting software does.
- **(b) An editable opening balance.** The wallet gets a starting figure set at
  creation and editable afterwards; the displayed balance is
  `opening + sum(transactions)`. Simple, but a later edit silently restates
  every historical balance.
- **(c) A stored balance column.** Direct, and wrong — it would drift from the
  transactions the moment either changes, with nothing to reconcile against.

Recommendation is (a), with the adjustment visible in the transaction list
rather than hidden.

## What is straightforward

- **Name** — a plain edit, same shape as the existing rename flows.
- **Currency** — editable only while the wallet has NO transactions. Changing
  it afterwards would reinterpret every stored minor-unit amount (SGD 10.00 and
  JPY 10 are both `1000` and `10` respectively under different minor units).
  Worth refusing explicitly rather than silently corrupting.
- **Wallet detail route** — `/wallets/[id]`, listing that wallet's
  transactions. The existing `/transactions` screen and its filters are the
  obvious thing to reuse rather than rebuild.

## Filter scope — needs a decision

The existing transactions screen already filters. Whether the wallet detail
screen reuses those filters wholesale, or gets a narrower set (date range,
kind, category), is a product call. Reusing is cheaper and more consistent.

## Security notes that will bind this work

- Renaming or editing a wallet is an OWNER action, not a member action —
  `wallets_write` RLS is already `owner_id = auth.uid()`.
- A wallet detail screen must scope its transaction query through RLS, not
  through a client-supplied wallet id trusted without a membership check.
- Archiving already exists and is separate; editing must not become a way to
  resurrect an archived wallet without going through that path.
