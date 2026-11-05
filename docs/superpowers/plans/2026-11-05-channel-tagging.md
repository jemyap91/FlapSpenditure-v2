# Channel Tagging and Card Bonus Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag every expense with a channel, flag spend that misses a card's bonus, and track each card's bonus spend against its max for its own billing cycle, in the app and through the MCP.

**Architecture:** One migration adds the channel, wallet bonus terms, merchant memory, a `channel_mismatch` computed column and a narrow `set_wallet_bonus` function. Pure rules live in `src/lib/card-bonus.ts`. `src/server/card-tracker.ts` is the only place tracker figures are calculated, so Home, the form and the MCP cannot disagree.

**Tech Stack:** Next.js 16 (App Router), Supabase Postgres with RLS, TypeScript strict, Tailwind, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-05-channel-tagging-design.md`. Read it; this plan argues from it. Mockups are in `.superpowers/brainstorm/55831-1793882094/content/` (`mismatch-flag.html` options A and C, `card-tracker.html` option A).

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (AGENTS.md).
- Channels, in display order: Online, In store, Bill, PayNow or transfer, Overseas.
- Money is `bigint` signed minor units; `parseFloat(x) * 100` is banned. Use `parseAmountInput` and `formatMoney`.
- Bonus spend sums `Math.abs(amount_minor)` of non-deleted expenses only. Repayments are never subtracted.
- Warnings never block saving, in the form or the MCP.
- A null channel is never a mismatch, and a wallet with no `bonus_channel` never flags.
- Past expenses are not backfilled.
- Colour is never the only cue. Every new control has a wallet-named accessible name.
- Migrations run through `supabase db reset`; regenerate types with `npm run db:types`, never by hand.
- Match surrounding code: comment density, naming, per-file `FOCUS_RING`.
- Tests run with `npm test`; SQL suites with `npm run test:rls` and `npm run test:constraints`; e2e with `npm run test:e2e`.

## Review Focus

- Merchant spelled differently, like " UNIQLO " and "uniqlo": both must hit one rule. Pinned in Tasks 2 and 3.
- Cycle start day past a short month's end, like the 31st in February: dates clamp with no gap or overlap. Pinned in Task 2.
- A deleted expense leaves the tracker, and restoring it brings it back. Pinned in Task 4.
- An expense moved to another wallet keeps its channel, but its mismatch and bonus count follow the new wallet. Pinned in Task 4.
- A card's terms changing mid-cycle updates old tags and totals at once, since nothing is stored. Pinned in Task 4.

---

### Task 1: Schema

**Files:**
- Create: `supabase/migrations/0033_channel_tagging.sql`
- Create: `src/lib/channels.ts`
- Modify: `src/lib/database.types.ts` (regenerated)
- Test: `supabase/tests/rls.sql`, `supabase/tests/constraints.sql`, `src/lib/channels.test.ts`

**Interfaces:**
- Produces: enum `expense_channel` with values `online`, `in_store`, `bill`, `paynow_transfer`, `overseas`.
- Produces: `transactions.channel`; `wallets.bonus_channel`, `wallets.cycle_start_day`, `wallets.bonus_cap_minor`.
- Produces: table `merchant_channels(space_id, merchant_key, channel, updated_at)`, primary key `(space_id, merchant_key)`.
- Produces: computed column `channel_mismatch(transactions) returns boolean`, usable in selects and `.filter("channel_mismatch", "eq", true)`, defined the way `effective_category_id` is in 0030.
- Produces: `set_wallet_bonus(p_wallet_id uuid, p_channel expense_channel, p_cycle_start_day smallint, p_cap_minor bigint) returns void`.
- Produces in `src/lib/channels.ts`: `type Channel`, `CHANNELS: readonly Channel[]` from `Constants`, `CHANNEL_LABELS: Record<Channel, string>`.

- [ ] **Step 1: Write failing SQL tests**

In `constraints.sql`, assert these fail: a non-null channel on an income row; `cycle_start_day` of 0 and 32; `bonus_cap_minor` of 0; a max with no channel; a max with no cycle day; a `merchant_key` that isn't `lower(btrim(...))`.

In `rls.sql`, following its two-user pattern, assert:
- A non-owner wallet member can call `set_wallet_bonus` and the three fields change.
- A non-owner still cannot `update wallets set name`.
- Nobody can write the bonus columns with a plain `update`, including the owner.
- A non-member calling `set_wallet_bonus` raises an error and changes nothing.
- A household member can read and write `merchant_channels` for their space; a user outside it reads zero rows.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:constraints && npm run test:rls`
Expected: FAIL, as the type and columns don't exist.

- [ ] **Step 3: Write the migration**

- `transactions.channel` is nullable, with `check (channel is null or kind = 'expense')`, plus `grant update (channel) on transactions to authenticated`. If the insert grant is column-based, extend it too.
- Wallet checks: `cycle_start_day between 1 and 31`, `bonus_cap_minor > 0`, and `bonus_cap_minor is null or (bonus_channel is not null and cycle_start_day is not null)`.
- Do not grant update on the bonus columns; `set_wallet_bonus` is their only write route.
- `set_wallet_bonus` is `security definer set search_path = ''`, raises unless `public.is_wallet_member(p_wallet_id)`, and updates only those three columns. Grant execute to `authenticated` only.
- `merchant_channels` policy: `for all to authenticated using (is_space_member(space_id)) with check (is_space_member(space_id))`, matching `categories_space`.
- `channel_mismatch` is true only when the row's channel and its wallet's `bonus_channel` are both set and differ.

- [ ] **Step 4: Run SQL tests, then regenerate types**

Run: `npx supabase db reset && npm run test:constraints && npm run test:rls && npm run db:types`
Expected: PASS, and `database.types.ts` lists `expense_channel`.

- [ ] **Step 5: Add `src/lib/channels.ts` with a test**

Test `every channel has a label`: `CHANNELS` equals `Object.keys(CHANNEL_LABELS)`, and the labels in order equal `["Online", "In store", "Bill", "PayNow or transfer", "Overseas"]`.

- [ ] **Step 6: Run and commit**

Run: `npm test -- src/lib/channels && npm run typecheck`
Expected: PASS.

```bash
git add supabase src/lib
git commit -m "feat: store expense channels, card bonus terms and merchant memory"
```

### Task 2: Pure bonus rules

**Files:**
- Create: `src/lib/card-bonus.ts`
- Modify: `src/lib/entry-suggestions.ts` (export `key` as `merchantKey`)
- Test: `src/lib/card-bonus.test.ts`

**Interfaces:**
- Consumes: `Channel` from Task 1.
- Produces:
  - `merchantKey(value: string | null | undefined): string`
  - `cycleFor(on: string, startDay: number): { from: string; to: string }`
  - `paceFor(a: { spentMinor: number; capMinor: number; from: string; to: string; today: string }): "reached" | "on_pace" | "under"`
  - `isMismatch(channel: Channel | null, bonusChannel: Channel | null): boolean`
  - `suggestChannel(ruleChannel: Channel | null, walletChannel: Channel | null): Channel | null`
  - `expenseWarnings(a: { walletName: string; bonusChannel: Channel | null; capMinor: number | null; currency: string; channel: Channel | null; amountMinor: number; spentBeforeMinor: number | null }): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ["2026-11-05", 1, "2026-11-01", "2026-11-30"],
  ["2026-11-05", 19, "2026-10-19", "2026-11-18"],
  ["2026-11-19", 19, "2026-11-19", "2026-12-18"],
  ["2026-11-24", 24, "2026-11-24", "2026-12-23"],
  ["2026-11-01", 2, "2026-10-02", "2026-11-01"],
  ["2027-01-05", 19, "2026-12-19", "2027-01-18"],
  ["2026-02-28", 31, "2026-02-28", "2026-03-30"],
  ["2026-03-30", 31, "2026-02-28", "2026-03-30"],
  ["2026-03-31", 31, "2026-03-31", "2026-04-29"],
])("cycleFor(%s, %i)", (on, day, from, to) => {
  expect(cycleFor(on, day)).toEqual({ from, to });
});
```

Also test:
- `paceFor`: `reached` at spent equal to max, even on day 1. `under` on day 2 however high the spend, below max. `on_pace` for 640/1000 on day 5 of 30. `under` for 100/1000 on day 15 of 30. A `today` after `to` uses the whole cycle.
- `isMismatch`: false when either side is null, false when equal, true when they differ.
- `suggestChannel`: the rule wins, then the wallet, then null.
- `merchantKey(" UNIQLO ") === merchantKey("uniqlo")`.
- `expenseWarnings` for Woman's World, bonus `online`, channel `in_store`: `["Woman's World earns its bonus Online, so this won't earn it."]`.
- `expenseWarnings` with channel `online`, $1,000 max, $990 spent, a $20 expense: one warning containing `past its $1,000.00 max`. Exactly at the max: none. `spentBeforeMinor: null`: no max warning.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/card-bonus`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `src/lib/card-bonus.ts`**

No I/O, and dates stay `YYYY-MM-DD` strings handled with `Date.UTC`, as `src/lib/month-range.ts` does. A cycle's start in any month is `min(startDay, lastDayOfMonth)`, and `to` is the day before the next start. Pace uses `elapsed = days from `from` to `min(today, to)`, inclusive`; before day 3 it can only be `reached` or `under`; otherwise `spent / elapsed * total >= cap` is `on_pace`. The max warning's copy is `This takes ${walletName} past its ${formatMoney(capMinor, currency)} max for this cycle.`, and it applies only when the channel equals the bonus channel and `spentBeforeMinor + amountMinor > capMinor`.

- [ ] **Step 4: Run and commit**

Run: `npm test -- src/lib/card-bonus src/lib/entry-suggestions`
Expected: PASS.

```bash
git add src/lib
git commit -m "feat: work out billing cycles, pace and channel mismatches"
```

### Task 3: Saving a channel

**Files:**
- Create: `src/server/merchant-channels.ts`
- Modify: `src/lib/validation/transaction.ts`, `src/server/actions/transactions.ts`, `src/server/actions/recurring.ts`
- Test: `src/server/actions/transactions.test.ts`, `src/server/actions/recurring.test.ts` (use the existing file if named differently), `src/lib/validation/transaction.test.ts`

**Interfaces:**
- Consumes: `suggestChannel`, `merchantKey`.
- Produces: `channel?: Channel | null` on `transactionInput` and `transactionEditInput`.
- Produces in `src/server/merchant-channels.ts` (`import "server-only"`):
  - `lookupMerchantChannel(supabase, spaceId: string, merchant: string | null): Promise<Channel | null>`
  - `rememberMerchantChannel(supabase, spaceId: string, merchant: string | null, channel: Channel, suggested: Channel | null): Promise<void>`

- [ ] **Step 1: Write the failing tests**

In `transactions.test.ts`, using its mock style:
- `createTransaction` with `channel` undefined stores the merchant rule's channel over the wallet's.
- With no rule, it stores the wallet's `bonus_channel`.
- With neither, it stores null.
- An explicit `null` stores null, with no suggestion applied.
- An explicit channel different from the suggestion upserts `merchant_channels` with key `uniqlo` for merchant ` UNIQLO `.
- An explicit channel equal to the suggestion writes no rule.
- A blank merchant writes no rule.
- A failed rule upsert still returns `{ id }`.
- `kind: "income"` stores null, and an explicit channel returns `{ error: "Only expenses have a channel" }`.
- `updateTransaction` with `channel` undefined leaves the column out of the update; a changed channel writes it and remembers it.

In the recurring test: `recordOccurrence` for an expense rule inserts the wallet's `bonus_channel`; an income rule inserts null.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/server/actions`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`undefined` means suggest on create and keep on update; `null` means deliberately blank. Extend the `wallets` selects to include `bonus_channel`. `rememberMerchantChannel` returns early for a blank merchant or `channel === suggested`, and logs rather than throws. In `recordOccurrence`, load the wallet's `bonus_channel` and set `channel` only for `kind === "expense"`.

- [ ] **Step 4: Run and commit**

Run: `npm test -- src/server/actions src/lib/validation && npm run typecheck`
Expected: PASS.

```bash
git add src
git commit -m "feat: suggest an expense's channel and remember corrections per merchant"
```

### Task 4: Tracker figures and card terms

**Files:**
- Create: `src/server/card-tracker.ts`, `src/server/actions/wallet-bonus.ts`
- Modify: `src/lib/validation/wallet.ts`
- Test: `src/server/card-tracker.test.ts`, `src/server/actions/wallet-bonus.test.ts`, `src/lib/validation/wallet.test.ts`, `supabase/tests/rls.sql`

**Interfaces:**
- Consumes: `cycleFor`, `paceFor`, `expenseWarnings`, `set_wallet_bonus`.
- Produces in `src/server/card-tracker.ts` (`import "server-only"`):

```ts
export type CardTrackerRow = {
  walletId: string; walletName: string; currency: string;
  bonusChannel: Channel; capMinor: number;
  from: string; to: string;
  spentMinor: number; remainingMinor: number;
  pace: "reached" | "on_pace" | "under";
  mismatchCount: number;
};
export function loadCardTracker(
  supabase: SupabaseServerClient,
  opts: { on: string; today: string; excludeTransactionId?: string },
): Promise<CardTrackerRow[]>;
export function warningsFor(
  supabase: SupabaseServerClient, transactionId: string,
): Promise<{ channel: Channel | null; warnings: string[] }>;
```

- Produces: `walletBonusInput` (`wallet_id`, `bonus_channel`, `cycle_start_day`, `max`: decimal string or null) and `setWalletBonus(input): Promise<{ ok: true } | { error: string }>`.

- [ ] **Step 1: Write the failing tests**

`card-tracker.test.ts`, on a fake client returning fixed rows:
- Citi Rewards (online, day 19, $1,000) on `2026-11-05`, with online expenses of $200 on `2026-10-19` and $110 on `2026-11-05`, and $50 online on `2026-10-18`: `from` `2026-10-19`, `to` `2026-11-18`, `spentMinor` 31000, `remainingMinor` 69000.
- An in-store expense in the cycle adds to `mismatchCount`, not `spentMinor`.
- A blank-channel expense adds to neither.
- `remainingMinor` is 0 at $1,080, and `spentMinor` stays 108000.
- `excludeTransactionId` leaves that expense out.
- An archived wallet and a wallet with no max produce no row.
- The query filters `deleted_at is null` and `kind = expense`. Spent for an expense present in one fixture and deleted in the next drops, then returns.
- After a fixture moves an expense to another wallet, it counts only on the new wallet, as mismatch or bonus by that wallet's channel.
- Changing a fixture wallet's `bonus_channel` from `online` to `in_store` swaps which expenses count, with no other change.
- `warningsFor` returns both warnings when both apply. An expense on `2026-11-05` is measured against its own cycle, and excludes itself from `spentBefore`.

`wallet.test.ts`: `max` without a channel or cycle day is refused with `Set a channel and cycle start day to use a max`. All-null is valid. Day 32 is refused.

`wallet-bonus.test.ts`: `setWalletBonus` converts `"1000"` in SGD to `p_cap_minor` 100000 using the wallet's currency, calls `set_wallet_bonus` once, and revalidates `/` and `/wallets`. An RPC error returns `{ error: "Could not save card terms. Please try again." }`.

Add an `rls.sql` case: `channel_mismatch` is true for an in-store expense on an online wallet, and flips after `set_wallet_bonus` changes the wallet.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/server/card-tracker src/server/actions/wallet-bonus src/lib/validation/wallet`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`loadCardTracker` selects non-archived wallets with `bonus_cap_minor` set, ordered by name, works out each cycle from `on`, and loads each wallet's expenses `occurred_on` within it. These are plain table reads under RLS, so a viewer sees only wallets they belong to. `paceFor` receives `opts.today`. `warningsFor` reads the transaction and its wallet, then calls `expenseWarnings`. `src/server/actions/wallet-bonus.ts` carries `"use server"` and follows `updateWallet`'s structure.

- [ ] **Step 4: Run and commit**

Run: `npm test -- src/server src/lib/validation && npx supabase db reset && npm run test:rls && npm run typecheck`
Expected: PASS.

```bash
git add src supabase
git commit -m "feat: calculate card bonus progress and let household members set card terms"
```

### Task 5: Card terms in wallet Settings

**Files:**
- Create: `src/components/WalletBonusForm.tsx`
- Modify: `src/app/(app)/wallets/WalletList.tsx`, `src/app/(app)/wallets/page.tsx`, `src/app/(app)/wallets/wallet-rows.ts`
- Test: `src/components/WalletBonusForm.test.tsx`, `src/app/(app)/wallets/WalletList.test.tsx`

**Interfaces:**
- Consumes: `setWalletBonus`, `CHANNELS`, `CHANNEL_LABELS`, `formatAmountInput`.
- Produces: `<WalletBonusForm wallet={{ id, name, currency_code, bonus_channel, cycle_start_day, bonus_cap_minor }} />`.
- Produces: dialog view `"terms"` in `WalletList`, titled `Card terms for ${name}`.

- [ ] **Step 1: Write the failing tests**

`WalletBonusForm.test.tsx`:
- Seeds from the wallet, showing `1000.00` for a max of 100000.
- Saving sends `{ wallet_id, bonus_channel: "online", cycle_start_day: 19, max: "1000.00" }`.
- Choosing "No channel" and clearing the rest sends nulls.
- An error result renders in a `role="alert"` node.

`WalletList.test.tsx`:
- A partner's wallet has no `Edit` control, but has `Card terms for Shared` on desktop and in the phone menu, opening a dialog with only these fields: `queryByLabelText("Name")` is null.
- An owner's edit dialog contains the card terms fields.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- WalletBonusForm WalletList`
Expected: FAIL.

- [ ] **Step 3: Implement**

The form uses a native `<select>`, a number input and a decimal text input, styled like `WalletForm`, with its own Save so it never submits through `updateWallet`. Render it below `WalletForm` in the `edit` view, and alone in the `terms` view. On a row with no `editActions` entry, put the `terms` control where the reserved slot sits, and add a `Card terms` menu item through a new `RowMoreMenu` prop `onTerms`. Add the three columns to the wallets select in `page.tsx`.

- [ ] **Step 4: Run and commit**

Run: `npm test -- WalletBonusForm WalletList && npm run typecheck`
Expected: PASS.

```bash
git add src
git commit -m "feat: set a card's bonus channel, cycle and max in wallet settings"
```

### Task 6: Channel on the entry form

**Files:**
- Modify: `src/components/TransactionForm.tsx`, `src/app/(app)/transactions/new/page.tsx`, `src/app/(app)/transactions/[id]/edit/page.tsx`
- Test: `src/components/TransactionForm.test.tsx`, `src/app/(app)/transactions/[id]/edit/page.test.tsx`

**Interfaces:**
- Consumes: `suggestChannel`, `merchantKey`, `expenseWarnings`, `loadCardTracker`, `CHANNELS`, `CHANNEL_LABELS`.
- Produces on both prop branches: `merchantChannels?: { merchant_key: string; channel: Channel }[]` and `cardRows?: CardTrackerRow[]`.
- Produces: `channel: Channel | null` on `EditTransactionSeed`, and `bonus_channel`, `bonus_cap_minor` on the form's `Wallet` type.

- [ ] **Step 1: Write the failing tests**

- The channel group appears for expenses, and not for income or transfer.
- Choosing a wallet with `bonus_channel: "online"` selects Online.
- Typing a merchant with a rule selects the rule's channel, ignoring case and spaces.
- After the user picks a channel, changing merchant or wallet leaves it alone.
- Tapping the selected channel clears it, and Save sends `channel: null`.
- Woman's World with In store shows `role="status"` text `Woman's World earns its bonus Online, so this won't earn it.`, and Save stays enabled.
- With `cardRows` showing $990 of $1,000 and an amount of $20 on the bonus channel, the max warning shows.
- A date outside that row's cycle shows no max warning.
- Edit mode seeds the stored channel, including null, and does not re-suggest on load.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- TransactionForm`
Expected: FAIL.

- [ ] **Step 3: Implement**

Chips are `<label>` radios like the kind selector, placed under the Merchant field, with a `channelTouched` state that starts true in edit mode. Follow `handleMerchantChange` for the merchant-driven update. Send `channel` on the create and edit expense paths only. Warnings render in one `role="status"` region. `spentBeforeMinor` comes from the selected wallet's `cardRows` entry when the date falls in `from`–`to`, else null. Both pages select the extra wallet columns, read `merchant_channels`, and call `loadCardTracker` with `on` and `today` of `todayLocalDate()`; the edit page also passes `excludeTransactionId`.

- [ ] **Step 4: Run and commit**

Run: `npm test -- TransactionForm src/app/\(app\)/transactions && npm run typecheck`
Expected: PASS.

```bash
git add src
git commit -m "feat: pick an expense's channel and see mismatch warnings before saving"
```

### Task 7: Activity tags and filters

**Files:**
- Modify: `src/components/TransactionList.tsx`, `src/lib/transaction-filters.ts`, `src/app/(app)/transactions/page.tsx`, `src/app/(app)/wallets/[id]/page.tsx`
- Test: `src/components/TransactionList.test.tsx`, `src/lib/transaction-filters.test.ts`, page tests beside those pages

**Interfaces:**
- Consumes: `channel_mismatch`, `CHANNEL_LABELS`.
- Produces: `Row.channel: Channel | null`, `Row.channel_mismatch: boolean`.
- Produces: `TransactionFilters.walletId?: string`, `TransactionFilters.mismatch?: true`, from `?wallet=<uuid>&mismatch=1`.

- [ ] **Step 1: Write the failing tests**

- The row's secondary line includes `In store`.
- A mismatch row shows `No bonus` as text.
- A null channel shows neither.
- `parseTransactionFilters({ wallet: "<uuid>", mismatch: "1" })` returns both, and `hasAnyFilter` is true.
- A bad wallet id or `mismatch=0` is dropped.
- The transactions page applies `.eq("wallet_id", id)` and `.filter("channel_mismatch", "eq", true)`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- TransactionList transaction-filters`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `channel, channel_mismatch` to both select strings. The filter bar must keep these params when it resubmits and must clear them with its existing reset; check how it builds its URL. Run `npm run test:embeds` if the selects change embeds.

- [ ] **Step 4: Run and commit**

Run: `npm test -- TransactionList transaction-filters src/app/\(app\) && npm run typecheck`
Expected: PASS.

```bash
git add src
git commit -m "feat: show each expense's channel and tag spend that earns no bonus"
```

### Task 8: Home tracker

**Files:**
- Create: `src/components/CardTracker.tsx`
- Modify: `src/app/(app)/page.tsx`
- Test: `src/components/CardTracker.test.tsx`, `src/app/(app)/page.test.tsx` (extend if present)

**Interfaces:**
- Consumes: `loadCardTracker`, `CardTrackerRow`.
- Produces: `<CardTracker rows={CardTrackerRow[]} />`.

- [ ] **Step 1: Write the failing tests**

- A row shows `Citi Rewards`, `$310.00 / $1,000.00`, `19 Oct–18 Nov` and `$690.00 left`.
- `on_pace` shows `on pace to hit max`.
- `reached` shows `max reached`, and $1,080 shows `$1,080.00 / $1,000.00`.
- The bar is `role="progressbar"` named after the wallet, with `aria-valuenow` capped at the max.
- `mismatchCount: 2` links `2 no bonus` to `/transactions?wallet=<id>&mismatch=1&from=2026-10-19&to=2026-11-18`; a count of 0 shows no link.
- No rows renders nothing.
- On Home, the section comes after `CategoryBreakdown` and before `CashFlow`, and still calls `loadCardTracker` with today's date under `?month=2026-09`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- CardTracker`
Expected: FAIL.

- [ ] **Step 3: Implement**

A Server Component, styled from `BudgetSummary`, with the heading `Card bonus`. In `page.tsx`, call `loadCardTracker(supabase, { on: today, today })` with the page's other reads, and throw `Failed to load card tracker` on failure, as those do. Render at line 422's position.

- [ ] **Step 4: Run and commit**

Run: `npm test -- CardTracker src/app/\(app\)/page && npm run typecheck`
Expected: PASS.

```bash
git add src
git commit -m "feat: track each card's bonus spend on Home"
```

### Task 9: MCP

**Files:**
- Modify: `src/server/mcp/tools.ts`, `src/server/mcp/protocol.ts`
- Test: `src/server/mcp/tools.test.ts`, `src/server/mcp/protocol.test.ts`

**Interfaces:**
- Consumes: `loadCardTracker`, `warningsFor`, `setWalletBonus`.
- Produces: tools `get_card_tracker { on? }` and `update_wallet_bonus { wallet_id, bonus_channel?, cycle_start_day?, max? }`.

- [ ] **Step 1: Write the failing tests**

- `create_transaction` passes `channel` through, leaves it undefined when omitted, and returns `{ id, channel, warnings }`.
- A saved mismatch returns `ok: true` with the warning sentence.
- `update_transaction` accepts `channel`, and its result carries `warnings`.
- `list_transactions` returns `channel` and `mismatch`, and applies `channel` and `mismatch: true` filters.
- `list_wallets` returns `bonus_channel`, `cycle_start_day` and `max` as a decimal string or null.
- `get_card_tracker` defaults `on` to today, passes a past date through, and returns decimal strings for `spent`, `max` and `remaining`, plus `from`, `to`, `pace` and `mismatch_count`.
- `update_wallet_bonus` merges omitted fields from the wallet's current values and calls `setWalletBonus`.
- `INSTRUCTIONS` matches `/warnings/i` in `protocol.test.ts`, and `tools/list` includes both new tools.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/server/mcp`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `channel: z.enum(CHANNELS).nullable().optional()` to `createInput` and `updateInput`, described as "Leave out to use the suggestion" and "Leave out to keep it" respectively. Add `channel, channel_mismatch` to `TRANSACTION_COLUMNS`. Extend `INSTRUCTIONS`:

```
"Saved expenses may return warnings; always tell the user each one. Leave channel out to use the " +
"suggested one. Use get_card_tracker for card bonus progress, and list_transactions with mismatch " +
"true to see expenses that earned no bonus."
```

- [ ] **Step 4: Run and commit**

Run: `npm test -- src/server/mcp && npm run typecheck`
Expected: PASS.

```bash
git add src
git commit -m "feat: Claude can set channels, warn about mismatches and report card progress"
```

### Task 10: End to end

**Files:**
- Create: `e2e/card-bonus.spec.ts`

- [ ] **Step 1: Write the spec, reusing `e2e/ledger.spec.ts`'s sign-up steps**

One test on both viewports:
1. Set a wallet to Online, cycle day 1, max $100 in its card terms.
2. Add a $30 Online expense at Uniqlo. Home shows `$30.00 / $100.00`.
3. Add a second expense at Uniqlo, choose In store, and expect the warning before saving.
4. Save. Activity shows `No bonus`, Home still shows $30.00 and `1 no bonus`.
5. Tap `1 no bonus` and expect only that expense.
6. Start a third expense at `uniqlo`, and expect In store preselected.
7. Add a $90 Online expense and expect the max warning, then `$120.00 / $100.00` on Home.

Add an axe check on Home, matching `expectNoViolations`.

- [ ] **Step 2: Run everything**

Run: `npm run lint && npm run typecheck && npm test && npm run test:rls && npm run test:constraints && npm run test:e2e`
Expected: all PASS, apart from the existing mobile-only skips.

- [ ] **Step 3: Commit**

```bash
git add e2e
git commit -m "test: cover the card bonus flow end to end"
```
