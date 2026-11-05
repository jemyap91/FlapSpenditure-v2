# Channel tagging and card bonus tracking — design

**Status:** DRAFT 2026-11-05, awaiting review. Adds a channel to expenses, bonus
terms to wallets, a tracker on Home, and matching MCP tools.

**Goal:** stop losing card bonuses. Each bonus card earns on one channel up to a
monthly max, and the app should show, the moment an expense is recorded, whether
it earned the bonus and how much room is left in that card's billing cycle.

```
Uniqlo   $42.50   Woman's World   In store
→ form: "Woman's World earns its bonus Online, so this won't earn it."
→ Activity: tagged "No bonus"
→ Home: not counted towards Woman's World's $1,000
```

## 1. Intent

Expenses are recorded right after paying, so a warning cannot save that purchase.
Its value is catching a wrong channel while it can still be fixed, and teaching
which card to use next time. The tracker's value is knowing when a card is near
its max, so spend can move to another card.

Goals:

- Every new expense has a channel, filled in automatically and always editable.
- A mismatch is visible at entry, in Activity, on Home and through Claude.
- Each bonus card's progress is visible for its own billing cycle.
- Anything the app can show about channels, mismatches and card progress can also
  be asked through the MCP.

Non-goals:

- Calculating rewards earned, in miles, points or dollars.
- Modelling each bank's exclusions, such as merchant category codes. The channel
  is the only test.
- Recommending which card to use before a purchase. Claude may reason from the
  tracker data if asked, but the app adds no recommendation feature.
- Backfilling channels on past expenses.

Anti-goals, which would make this a failure even if it works:

- A warning that blocks saving, or adds a step to quick entry.
- A first summary full of false flags from old, untagged expenses.
- A tracker figure that disagrees between Home and Claude.

## 2. Decisions

| Decision | Choice | Source |
|---|---|---|
| Channels | Online, In store, Bill, PayNow or transfer, Overseas | User |
| Suggestion order | Merchant rule, then wallet's channel | User |
| Editing | Always editable at entry | User |
| Corrections | Remembered per merchant | User |
| Channels per card | One; it is the channel that earns the bonus | User |
| Mismatch | Expense's channel differs from the wallet's channel | User |
| Where it shows | Warning on the form before saving, and a lasting tag in Activity | User |
| Claude | Warns about mismatches, and can answer anything the app shows | User |
| Max | $1,000 on each card, except UOB One at $500; only bonus-channel spend counts | User |
| Cycles | Woman's World from the 1st, UOB One the 2nd, Citi Rewards the 19th, OCBC cards the 24th | User |
| Tracker location | Home, directly under the spend categories | User |
| Card setup | Three optional wallet fields, in wallet Settings | Agreed guess |
| Which cards appear | Wallets with a max set | Agreed guess |
| Unset channel | Wallet with no channel never flags | Agreed guess |
| Scope of channel | Expenses only, not income, transfers or repayments | Agreed guess |
| Past expenses | Stay blank, never count as mismatches | Agreed guess |
| Merchant memory | Shared across the household, including merchants from private wallets | User |
| Warnings | Never block saving | Agreed guess |
| Over the max | Warn; the tracker shows the true figure, e.g. $1,080 / $1,000 | Agreed guess |
| Pace | Simple projection from spend so far this cycle | Agreed guess |
| Mismatch summary | Per-card count in the tracker, by billing cycle, opening those expenses in Activity | Agreed guess |
| Earlier months on Home | Tracker always shows the current cycle | Agreed guess |
| Repayments | Do not lower bonus spend, accepting the tracker reads high after a returned purchase (see §4.4) | User |
| Recurring expenses | Take the card's channel and count towards its max | User |
| Who sets bonus terms | Any household member who can see the wallet, not just its owner | User |

## 3. Data

### 3.1 Channel

A new `expense_channel` Postgres enum, surfaced through `Constants` the way
`wallet_kind` is, and a nullable `transactions.channel`. A check constraint keeps
it null on every kind but `expense`. Null means no channel was recorded, and a
null channel is never a mismatch.

### 3.2 Wallet bonus terms

Three nullable columns on `wallets`, with checks:

- `bonus_channel expense_channel`
- `cycle_start_day smallint`, between 1 and 31
- `bonus_cap_minor bigint`, positive, in the wallet's currency

`bonus_channel` alone is valid, and gives a wallet a default and mismatch flags
without a tracker row. A max requires a channel and a cycle start day. The max is per wallet, not hard-coded, so a change to a card's
terms is a settings edit.

A start day past the end of a short month clamps to that month's last day.

### 3.3 Merchant channel memory

A `merchant_channels` table keyed by `(space_id, normalised merchant)` holding the
channel, with RLS matching the household's other space-scoped data. Expenses in
private wallets write rules too, so housemates can see those merchants in this
table; the user accepted that. Normalisation
is the trim and lower-case that `get_entry_suggestions` (0026) and
`src/lib/entry-suggestions.ts` already use.

A rule is written when a saved expense's channel differs from what would have
been suggested for it, in the same server action that saves the expense. Claude's
writes go through that action too, so a correction made in chat is remembered.

## 4. Behaviour

### 4.1 Suggesting

For a merchant and wallet: the merchant rule if one exists, else the wallet's
`bonus_channel`, else nothing. The form recalculates when the merchant or wallet
changes, until the user picks a channel themselves; after that their choice
stands, the same way a typed category survives the merchant prefill in
`handleMerchantChange`.

Blank stays allowed, so a wallet with no channel and a new merchant adds no step.

`create_transaction` applies the same order when Claude sends no channel, so both
routes produce the same result.

Recurring entries have no merchant (`recordOccurrence` in
`src/server/actions/recurring.ts`), so they take the wallet's `bonus_channel`. They
are never left blank when the wallet has one, so they count towards its max like
any other bonus-channel expense.

### 4.2 Mismatches

One pure function decides this, used by the form, Activity, the tracker and the
MCP: a mismatch exists when the expense's channel and the wallet's `bonus_channel`
are both set and differ. It is derived at read time, not stored, so editing a
wallet's channel or an expense updates every view at once.

### 4.3 Entry form

`TransactionForm` gets a channel chip row for expenses, on both new and edit. The
mockup is `mismatch-flag.html`, option A: when a mismatch exists, an inline warning
sits under the chips, naming the card and its channel. A second inline warning
appears when the expense would take the card past its max. Neither blocks Save.

### 4.4 Bonus spend for a cycle

Bonus spend is the sum of a wallet's non-deleted expenses where `occurred_on` falls
in the cycle and `channel = bonus_channel`. An expense counts in the cycle of its
own date.

**Repayments are not subtracted.** The app's `refund` kind records friends paying
you back (2026-09-30-refunds-design.md), which does not change what the bank counts
towards the bonus. A returned purchase recorded the same way also won't lower it,
so the tracker can read high after a return. The user accepted this.

Soft-deleted expenses stop counting, and restoring one brings it back.

### 4.5 Pace

`spent ÷ days elapsed × days in cycle`, compared to the max. "On pace to hit max"
shows when the projection reaches the max, and only from day 3 of a cycle, so one
early purchase doesn't trigger it. At or past the max it reads as reached instead.

### 4.6 Home tracker

A new section directly after `CategoryBreakdown` in `src/app/(app)/page.tsx`, before
`CashFlow`, matching the "Card bonus" mockup in `card-tracker.html` option A. One
row per non-archived wallet with a max, showing name, spent / max, a progress bar,
the cycle dates, either the remaining amount or the pace line, and the cycle's
mismatch count ("2 no bonus") when above zero.

The bar's state is never carried by colour alone. Tapping the count opens Activity
filtered to that wallet, cycle and mismatches, which needs new `wallet` and
`mismatch` filters in `src/lib/transaction-filters.ts`.

The section stays on the current cycle while browsing an earlier month, and is
absent when no wallet has a max.

### 4.7 Activity

Expense rows show the channel. A mismatch row shows a "No bonus" tag, as in
`mismatch-flag.html` option C.

### 4.8 Wallet settings

`WalletForm` gets channel, cycle start day and max.

These three fields are an exception to owner-only wallet edits: any household
member who can see a wallet can set them, because Cheryl's OCBC sits under Cheryl's
login and needs setting up from either account. `wallets_write` stays owner-only, so
this needs its own narrow route, such as a SECURITY DEFINER function that can write
only these columns after checking the caller can see the wallet. Other members see
just these fields for a wallet they don't own, never the rest of the form.

## 5. MCP

All figures come from the same code as the app, per the anti-goal above.

- `create_transaction` and `update_transaction` accept `channel`. Their results
  include the channel used, plus a `warnings` list covering a mismatch and passing
  the max, each a sentence Claude can repeat.
- `list_transactions` returns `channel` and `mismatch`, and accepts `channel` and
  `mismatch` filters.
- `list_wallets` returns the three bonus fields.
- New `get_card_tracker { on? }` returns each tracked wallet's cycle dates, spent,
  max, remaining, pace and mismatch count, as of `on`, default today. A past date
  answers questions about an earlier cycle.
- New `update_wallet_bonus { wallet_id, ... }` sets the three fields, through the
  same server action and the same household exception as the form.
- `INSTRUCTIONS` in `src/server/mcp/protocol.ts` tell Claude to relay every warning
  to the user, and that the channel can be left out to use the suggestion.

## 6. Initial setup

This feature does nothing until cards are configured. They are set in wallet
Settings or through Claude after release; the migration does not seed terms,
because it can't know which wallet rows they apply to.

| Wallet | Channel | Cycle starts | Max |
|---|---|---|---|
| DBS Woman's World | Online | 1 | $1,000 |
| Citi Rewards | Online | 19 | $1,000 |
| Cheryl's OCBC | In store | 24 | $1,000 |
| UOB One | Bill | 2 | $500 |

All four appear in the tracker. The user described the OCBC cycle as "24 Nov", read
here as the 24th of each month, and it applies to every OCBC credit card.

## 7. Left to the builder

- Migration split, RPC versus query for tracker data, and component structure.
- Exact copy, and how the chips sit in the form's existing layout on a small phone.
- Where the "cycle for a date" helper lives, with the month helpers being the
  obvious neighbour. It needs tests for month ends and the year boundary.
- Keeping the existing RPCs' return types stable when `channel` is added.
