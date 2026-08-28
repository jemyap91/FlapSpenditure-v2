# Wallet Detail and the Account→Wallet Rename — Design

**Status:** approved in conversation 2026-08-27.

**Supersedes:** the capture notes at
`2026-08-26-wallet-editing-and-detail-notes.md` for the *detail screen* half.
The *editing* half of those notes — particularly the question of what an
"editable balance" means — is deliberately NOT in scope here and still awaits
a decision.

**Goal.** Click a wallet, see its transactions, and add one to it without
losing your place.

---

## 1. The rename, and the trap in it

The app currently calls a wallet an "account" in user-visible copy. The request
is to call it a wallet.

**193 references to "account" exist across 20 files, and they are two different
nouns:**

| Sense | Examples | Rename? |
|---|---|---|
| **Wallet** | `Add account`, `No accounts yet`, `Accounts this budget covers`, `All accounts`, `3 accounts`, `Covers an archived account` | **Yes** |
| **User account** | `Create account` on signup, the login form, onboarding copy | **No** |

A global find-and-replace renames the signup button to "Create wallet". The
rename must be selective, by sense, not by string.

**Accepted cost.** The wallet-set budgets feature pins seven accessible names
containing "accounts", asserted by unit tests and one e2e spec. Renaming means
updating those contracts in step. That is the difference between a five-file
change and a twenty-file one, and it is worth paying once rather than living
with two nouns for one concept.

**Not renamed:** the `wallets` table, the `/wallets` route, and every internal
identifier — all of which already say "wallet". This rename only closes the gap
between the schema's vocabulary and the screen's.

---

## 2. `/wallets/[id]` — the detail screen

A Server Component route showing one wallet: its name, type, currency, balance,
and its transactions.

- **Transactions come from the existing list**, not a rebuilt one. The
  `/transactions` screen already renders and filters; the detail screen reuses
  that component scoped to one wallet rather than growing a parallel
  implementation.
- **Membership is enforced by RLS, not by the route.** The `[id]` segment is
  user-supplied. The query must be scoped through RLS as every other read in
  this app is; a wallet id the caller cannot see returns no rows, and the page
  renders a not-found state rather than leaking existence.
- **Archived wallets remain reachable** by direct link — archiving hides a
  wallet from lists, it does not delete its history. The page states the
  archived status rather than pretending the wallet is ordinary.

Clicking a wallet's name on `/wallets` navigates here. Members and Archive stay
on the list card, where they are today.

---

## 3. The add-transaction affordance

A floating action button, bottom right of the detail screen, linking to
`/transactions/new?wallet=<id>` with that wallet preselected.

`/transactions/new` currently accepts no search params and defaults its wallet
selection internally. It gains one optional `wallet` param, validated as a uuid
and ignored if it names a wallet the caller cannot see — never trusted as a
selection on its own.

---

## 4. Returning to the wallet — the part with a sharp edge

`TransactionForm` currently does `router.push("/transactions")` after a
successful save. To return to the originating wallet it must know where it came
from.

**A redirect target taken from user-supplied input is an open-redirect vector.**
The form receives a `from` value and must never treat it as a path.

**Decision: pass an ORIGIN IDENTIFIER, not a URL.** The param is
`?from=wallet:<uuid>`. The receiving code validates the uuid and *constructs*
`/wallets/<uuid>` itself. There is no code path in which a user-supplied string
becomes a redirect destination.

Rejected alternatives, recorded so they are not revisited:

- **`?return=/wallets/abc`** — a path from the query string. Even with a
  same-origin check this is the shape that goes wrong; a validated identifier
  removes the class rather than filtering it.
- **The `Referer` header** — absent, spoofable, and stripped by some privacy
  settings. Not a basis for navigation.

**Fallback:** with no `from`, or an unparseable one, or one naming a wallet the
caller cannot see, the form redirects to `/transactions` exactly as it does
today. The new behaviour is additive; the old path is the default.

---

## 5. Select all / clear all in the budget wallet picker

A single link-styled toggle beside the `Accounts this budget covers` legend
(`Wallets this budget covers` after §1):

- reads **Select all** when any wallet is unchecked
- reads **Clear all** when all are checked

One control, self-describing, no tri-state indeterminate checkbox. Clearing all
is permitted — it is the normal first step when picking two of nine — and the
existing zod `.min(1)` already refuses an empty set on submit.

**It appears only when creating a budget.** `set_budget` never mutates an
existing budget's wallet set; submitting a different set creates a *second*
budget. Existing rows therefore have no wallet picker for this control to join.

---

## 6. Testing

**Unit.** The rename's pinned accessible names, updated in step. The toggle's
four states (select all, clear all, label flips when one is unchecked, label
flips back). The origin parser: a valid `wallet:<uuid>`, a malformed one, an
absent one, and — the one that matters — a `from` value that looks like a URL
(`from=https://evil.example`, `from=//evil.example`, `from=/wallets/../admin`)
must all fall back to `/transactions` and never redirect anywhere else.

**End-to-end.** Click a wallet, land on its detail screen, see its transactions
and not another wallet's. Press the plus, record an expense, and land back on
that wallet rather than `/transactions`. Each of those must be watched failing.

**Not vacuous.** The "lands back on the wallet" assertion must fail if the
redirect regresses to `/transactions` — assert the destination URL, not merely
that a transaction was saved.

---

## 7. Out of scope

Editable wallet name, balance or currency — the open question from the
2026-08-26 notes (balance is derived from transactions, so "editable" has to
mean recording an adjustment) stands unanswered and is not decided here.
Filtering on the detail screen beyond what `/transactions` already offers.
Changing a budget's wallet set after creation.

---

## 8. Risks

1. **The rename touches a feature's pinned test contracts.** Seven accessible
   names, three spec files. Mechanical, but a missed one is a red suite rather
   than a silent bug, which is the right failure mode.
2. **`/wallets/[id]` is a new user-supplied identifier reaching a query.** RLS
   is the boundary, as everywhere else; the route must not add its own weaker
   check alongside it.
3. **The redirect is the only genuinely security-shaped change here** (§4), and
   the identifier-not-URL decision is what keeps it small.
