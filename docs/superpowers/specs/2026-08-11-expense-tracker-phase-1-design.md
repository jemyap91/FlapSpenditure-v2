# Expense Tracker — Phase 1 Design

**Date:** 2026-08-11
**Status:** Approved for planning
**Scope:** Phase 1 of 3 — the core ledger

---

## 1. Context

A personal expense tracker modelled on [Spendee](https://help.spendee.com/category/129-spendee-features), built as a responsive web app with real accounts and (eventually) shared wallets.

The full Spendee feature set — wallets, transactions, categories, budgets, scheduled transactions, multi-currency, shared wallets, CSV import/export, bulk edit, receipt scanning, PWA, passcode — is too large for a single spec. It is decomposed into three phases, each with its own spec → plan → build cycle.

| Phase | Contents |
|---|---|
| **1 (this spec)** | Auth, wallets, transactions (expense / income / **transfer**), categories, transaction list and entry, dashboard, light/dark |
| 2 | Budgets with alerts and safe-to-spend, scheduled transactions, multi-currency + all-wallets overview |
| 3 | Shared wallets + invites + realtime, CSV import/export, bulk edit, receipt AI scan, PWA + passcode |

The cut is chosen so each phase leaves the *shape* the next one needs without building it. Phase 1 therefore ships `wallet_id` on every transaction and a `wallet_members` table even though there is exactly one member per wallet, so phase 3 is "write the invite flow and the policies" rather than "migrate every table."

**Transfers are not deferrable.** A transfer is not a feature bolted onto a transaction; it is a different thing the `transactions` table must be able to represent. Retrofitting it means rewriting every report.

---

## 2. Architecture

A single Next.js App Router application against Supabase Postgres. No separate API service.

| Layer | Choice |
|---|---|
| Framework | Next.js 15, App Router, TypeScript `strict` |
| Data | Supabase Postgres, accessed server-side with the user's session |
| Auth | Supabase Auth — email/password + magic link; httpOnly cookies via `@supabase/ssr`, refreshed in middleware |
| Styling | Tailwind + CSS custom properties for theme tokens |
| Components | shadcn/ui as a base, restyled |
| Charts | Recharts |
| Validation | Zod schemas shared between client forms and Server Actions |
| Tests | Vitest, Playwright, SQL policy tests |

### Non-negotiable rules

1. **The browser never writes to Supabase directly.** All mutations go through Server Actions. RLS still guards the tables, but the Action is where Zod validation, business invariants, and the transfer-pair transaction live.
2. **Money never becomes a float.** `bigint` minor units in the database; `number` in TypeScript only for display. Exactly two helpers touch the conversion: `formatMoney(minor, currency)` and `parseAmountInput(string)`. `parseFloat(x) * 100` is banned — it returns `1250.0000000000002` for some inputs and silently corrupts the ledger.
3. **Aggregates go through `security definer` RPCs.** Dashboard rollups check membership once, then aggregate with RLS out of the way. A plain `SELECT` re-evaluates the policy subquery on every scanned row.
4. **The add-transaction modal is state, not a route, on desktop.** As a route it would need somewhere to navigate back to on close, and a hard refresh mid-entry would land on a bare modal. On mobile it *is* a full screen and therefore a real route with back-button behaviour.

---

## 3. Data model

```
profiles          id -> auth.users, display_name, base_currency, theme
currencies        code (PK), minor_unit, symbol, name          [reference data]
wallets           id, owner_id, name, currency_code,
                  starting_balance_minor, color_slot, icon,
                  archived_at, created_at, updated_at
wallet_members    wallet_id, user_id, role, joined_at          [PK: wallet_id+user_id]
categories        id, owner_id, name, kind, color_slot, icon,
                  sort_order, is_default, archived_at
transactions      id, wallet_id, created_by, kind,
                  amount_minor, currency_code, category_id,
                  transfer_id, note, occurred_on,
                  created_at, updated_at, deleted_at
```

### 3.1 Money

`amount_minor bigint` — **signed**. Negative for expenses and transfer-out, positive for income and transfer-in.

`currencies.minor_unit` holds the decimal exponent, because it is not always 2: JPY is 0, KWD is 3.

Wallet balance is then a single expression with no branching:

```sql
starting_balance_minor + COALESCE(SUM(amount_minor), 0)
```

`currency_code` is denormalised onto `transactions` even though it is derivable from the wallet. This is deliberate: a ledger entry must remain a truthful record of what happened, so correcting a wallet's currency must not rewrite history. The same principle will apply to FX rates in phase 2 — pin the rate onto the row, or last month's report changes every time it is opened.

### 3.2 Transfers are paired rows

A transfer is **two rows sharing a `transfer_id`**, not one row with two wallet columns.

The rejected alternative — `wallet_id` + `counter_wallet_id` on one row — reads more naturally but poisons every downstream query: a wallet's ledger becomes `WHERE wallet_id = $1 OR counter_wallet_id = $1`, and the amount's sign depends on which branch matched. With paired rows:

- a wallet's ledger is always `WHERE wallet_id = $1`
- the sign is always already correct
- each leg carries its own currency and amount, which is exactly what a cross-currency transfer needs in phase 2, for free

Cost: the pair must be created, edited and deleted together. That lives in one Server Action wrapped in a transaction, with `ON DELETE CASCADE` on the `transfer_id` link.

### 3.3 Invariants are CHECK constraints

The database refuses to hold a nonsensical row:

```sql
CHECK (kind <> 'expense'  OR amount_minor < 0)
CHECK (kind <> 'income'   OR amount_minor > 0)
CHECK (kind <> 'transfer' OR (category_id IS NULL AND transfer_id IS NOT NULL))
CHECK (kind  = 'transfer' OR transfer_id IS NULL)
```

Reports become correct by construction: category and income/expense rollups filter `kind <> 'transfer'`; cash flow does not. That single line is Spendee's documented transfer behaviour, enforced rather than remembered.

### 3.4 Soft delete

`deleted_at` ships in phase 1 despite undo being the only consumer, because retrofitting soft delete is a schema migration *plus* an audit of every existing query to add `AND deleted_at IS NULL`. One column now, a codebase review later.

### 3.5 Enumerated values

| Column | Type | Values |
|---|---|---|
| `transactions.kind` | enum | `expense` · `income` · `transfer` |
| `categories.kind` | enum | `expense` · `income` |
| `wallet_members.role` | enum | `owner` · `member` — phase 1 only ever writes `owner`; `member` exists so phase 3's invite flow is a data change, not a migration |
| `wallets.color_slot`<br>`categories.color_slot` | `smallint` 1–8 | An index into the validated palette (§6.1), **not** a hex string. Storing hex would let a future colour bypass `scripts/validate-palette.mjs`; storing a slot makes that structurally impossible. |
| `profiles.theme` | enum | `system` · `light` · `dark` |

### 3.6 Seed data

Onboarding seeds **12 default expense categories and 4 income categories** per user, each with an icon, a `sort_order`, and `is_default = true`.

Twelve categories against eight colour slots means slots repeat by design — categories 9–12 reuse slots 1–4. This is the §6.1 ceiling applied: identity for a repeated slot is carried by the icon and name, and the charts fold the tail into "Other" before two same-coloured categories can appear in one view. Defaults are user-owned rows, so they are editable and archivable like any other category.

### 3.7 Indexes

```sql
CREATE INDEX ON transactions (wallet_id, occurred_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON transactions (category_id);
CREATE INDEX ON transactions (transfer_id);
```

---

## 4. Access control

Every authorization question reduces to one predicate, defined once:

```sql
CREATE FUNCTION is_wallet_member(w uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (
  SELECT 1 FROM wallet_members
  WHERE wallet_id = w AND user_id = auth.uid()
) $$;
```

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `profiles` | `id = auth.uid()` | `id = auth.uid()` |
| `currencies` | any authenticated user | none — seeded by migration |
| `wallets` | `is_wallet_member(id)` | `owner_id = auth.uid()` |
| `wallet_members` | `is_wallet_member(wallet_id)` | wallet's `owner_id = auth.uid()` |
| `categories` | `owner_id = auth.uid()` | `owner_id = auth.uid()` |
| `transactions` | `is_wallet_member(wallet_id)` | `is_wallet_member(wallet_id)` |

Note the asymmetry on `wallets`: **members can see it, only the owner can change it.** That is Spendee's owner/guest split, encoded before there are guests to test it with.

### 4.1 `SECURITY DEFINER` is required, not stylistic

If `wallets`'s policy queries `wallet_members`, and `wallet_members`'s policy queries `wallets`, Postgres reports `infinite recursion detected in policy for relation "wallets"`. The recursion is between two policies that each look correct in isolation, which makes it hard to diagnose.

A `SECURITY DEFINER` function runs as its owner with RLS bypassed inside the body, cutting the loop. **`SET search_path = public` is mandatory** — without it the function is a privilege-escalation vector, because a caller can point `search_path` at a schema containing their own `wallet_members`.

### 4.2 Aggregate RPCs

- `get_wallet_balances(user_id)` — balance per wallet
- `get_category_breakdown(wallet_ids[], from, to)` — `kind <> 'transfer'`
- `get_cash_flow(wallet_ids[], from, to, bucket)` — transfers **included**

Each validates membership for all supplied wallet IDs up front and returns empty rather than erroring on a wallet the caller does not belong to.

---

## 5. Screens

Mobile gets a bottom tab bar; desktop gets a persistent left sidebar.

| Route | Purpose |
|---|---|
| `/login`, `/signup` | Email+password and magic link |
| `/onboarding` | First wallet, base currency, seeds the default categories (§3.6) |
| `/` | Dashboard — month selector, totals, category breakdown, cash flow, recent transactions |
| `/transactions` | Full list grouped by day, infinite scroll, filter by wallet / category / type |
| `/transactions/new` | Mobile: full-screen keypad. Desktop: redirects to `/` with the modal open |
| `/transactions/[id]` | Detail and edit; deleting a transfer removes both legs behind one confirmation |
| `/wallets` | List with balances; create, rename, recolour, archive |
| `/categories` | Manage, reorder, archive (never hard-delete — it would orphan history) |
| `/settings` | Profile, base currency, theme |

### 5.1 Add-transaction flow

Amount-first. The screen opens with the amount focused and zeroed, above a custom numeric keypad.

The amount field is **not** `<input type="number">`. It is an element with `inputMode="none"` whose value is driven by React state from the app's own key handlers. Consequences, all intended:

- the OS keyboard never appears, so the layout never shifts and Save is always reachable
- the app owns caret, backspace and decimal behaviour — including rejecting a second decimal point and capping at the currency's `minor_unit` digits
- the value never passes through a float: `"12.50"` becomes `1250` by string manipulation

Type switcher across the top: **Expense · Income · Transfer**, defaulting to Expense. The chip row adapts:

- Expense / Income → `[Category] [Wallet] [Date]`
- Transfer → `[From wallet] [To wallet] [Date]` — the category chip is **removed, not disabled**, because a transfer has no category and a greyed-out control invites a click that can never succeed

Defaults: last-used wallet, today. The common case is amount → category → Save.

**On save** the row is inserted optimistically and a toast offers **Undo** for five seconds. A rejected Server Action rolls the row back and surfaces the error on the offending field. Undo issues a soft delete — for a transfer, restoring both legs atomically, which a reconstruct-and-reinsert approach could leave half-done.

Confirmation dialogs are deliberately avoided in favour of undo: dialogs interrupt every action to prevent a rare mistake, whereas undo lets every action complete instantly and only costs the user when they actually erred.

**Desktop keyboard path:** `A` opens the modal from anywhere; digits type the amount; `Tab` moves between chips; `↑`/`↓` select within a chip's popover; `Enter` saves; `Esc` cancels, with a confirm if anything was entered.

### 5.2 States

Every list screen specifies four states — loading skeleton, empty, error with retry, populated. Empty states are design work, not placeholder text. The transaction list has **two distinct** empty states: no data yet (the fix is adding a transaction) and a filter matched nothing (the fix is clearing the filter).

---

## 6. Design system

Dark is the default mode. Bold, high-contrast, large numerals.

### 6.1 Categorical palette — fall

Derived, not hand-picked: in-gamut steps were generated at fixed OKLCH hue angles, then slot orderings and lightness steps searched under the accessibility gates, treating colour-vision separation as a **constraint** and autumn character as the objective.

That ordering matters. An earlier search optimised separation directly and returned sage, spruce and teal — a forest palette with a single warm hue — because separation and warmth pull against each other. Warm-versus-warm is the hard case for colour-vision deficiency, and a fall palette is mostly warm.

| Slot | Family | Light | Dark |
|---|---|---|---|
| 1 | brick | `#ba362e` | `#e86154` |
| 2 | amber | `#b67c10` | `#8c5e09` |
| 3 | fern | `#0a7039` | `#16ae5b` |
| 4 | olive | `#918e10` | `#6f6d0a` |
| 5 | wine | `#c7436d` | `#d55078` |
| 6 | ochre | `#a48610` | `#7e660a` |
| 7 | plum | `#b84999` | `#c656a6` |
| 8 | sage | `#1a8210` | `#2b8f22` |

Five leaf tones and three greens. Verified by `scripts/validate-palette.mjs`:

```
DARK   CVD ΔE 10.0 (protan)  normal 18.2   contrast all >= 3:1   PASS
LIGHT  CVD ΔE 10.2 (deutan)  normal 16.0   contrast all >= 3:1   PASS
```

**The slot order is the safety mechanism, not decoration.** Re-ordering or re-stepping requires re-running the validator.

**Eight is the ceiling.** A ninth generated hue is indistinguishable from an existing one under colour-vision deficiency. Category nine onward reuses slots and relies on its icon and name for identity; charts fold the tail into "Other". Colour follows the category permanently, assigned at creation, and never repaints when a filter changes what is on screen.

**Adjacent-pairs scope.** These margins are validated on the adjacent pairlist, which covers stacked bars, ranked lists and lines — every chart in phase 1. They do **not** hold for scatter or small multiples, where any two of the eight can sit side by side. Such a chart caps at three series with the tail folded into "Other"; the palette does not change.

### 6.2 Supporting roles

A fall palette contains no blue, so the diverging pair is drawn from outside the categorical eight:

- **Diverging** (cash flow above/below zero): teal `#17a2a2` in, rust `#e36a1f` out, neutral grey midpoint (`#383835` dark, `#f0efec` light). Both poles clear 3:1 in both modes. Cool-versus-warm, so the poles read as opposite.
- **Sequential** (magnitude): rust, one hue, light → dark.
- **Status** keeps its fixed steps and is never themed: good `#0ca30c`, warning `#fab219`, serious `#ec835a`, critical `#d03b3b`.

> **Status hazard specific to this palette.** Status-critical and status-serious sit in the same hue families as slots 1 (brick) and 6 (ochre). On a warm-dominant palette a status colour can impersonate a category. Mitigation is structural: status never appears inside a category chart, and every status indicator ships with an icon and a label so hue never carries meaning alone.

### 6.3 Chrome

| Role | Dark (default) | Light |
|---|---|---|
| Page plane | `#0d0d0d` | `#f9f9f7` |
| Card surface | `#1a1a19` | `#fcfcfb` |
| Primary ink | `#ffffff` | `#0b0b0b` |
| Secondary ink | `#c3c2b7` | `#52514e` |
| Muted / axis | `#898781` | `#898781` |
| Gridline | `#2c2c2a` | `#e1e0d9` |
| Positive amount | `#0ca30c` | `#006300` |
| Negative amount | `#e66767` | `#d03b3b` |

Theme tokens are CSS custom properties so switching is a class on `<html>`, not a React re-render.

### 6.4 Typography and figures

System sans throughout, **including the hero figure** — no serif, no display face. The month total is the hero number at ≥48px with *proportional* figures. `font-variant-numeric: tabular-nums` is reserved for the transaction list and axis ticks, where digits must align vertically.

**Amount signs are always rendered** — `−12.50`, `+3,200.00`. Colour reinforces the sign; it never replaces it.

### 6.5 Charts

**Category breakdown is a stacked bar plus a ranked list — not a donut.** Donuts are for part-to-whole at a glance with ≤6 segments and are specifically bad at comparing close values, which is exactly the question an expense tracker is asked ("worse on groceries or transport?"). A real tracker has a long tail of similar-sized categories, the worst case for a pie.

- one horizontal stacked bar for the month's spend — top 6 categories plus "Other", 2px surface gaps between segments
- a ranked list below it: colour chip, name, bar, exact amount

**Cash flow is a diverging bar, not a line.** Money above and below a zero baseline is polarity, not trend. One bar per day or week, teal in / rust out, neutral grey at zero.

Deliberately **not** green/red: that is the worst pairing under the two most common colour-vision deficiencies, and it would be carrying the most important distinction in the app.

Marks are thin; 2px lines; ≥8px markers with ~24px hit areas; hairline gridlines one shade off the surface, never dashed. Every chart has a crosshair or per-mark tooltip **and** a table-view twin — tooltips enhance, never gate a value.

---

## 7. Verification

| Layer | Coverage |
|---|---|
| SQL policy tests | Connect as user B; attempt to read and write user A's wallet and transactions; assert zero rows and rejected writes. Against a real Postgres in CI. |
| Unit (Vitest) | `parseAmountInput` / `formatMoney` across USD, JPY, KWD; the transfer-pair builder; CHECK violations surface as typed errors |
| Integration | Balance after a mixed sequence of expense, income, transfer, edit, soft-delete, undo. Reports exclude transfers; cash flow includes them. |
| E2E (Playwright) | Signup → onboarding → add expense → add transfer → verify both balances → edit → undo. Mobile and desktop viewports. |
| Accessibility | axe on every route in both themes; full keyboard traversal of the add flow |
| Palette | `node scripts/validate-palette.mjs` wired into CI |

Two of these are unusual and deliberate.

**The palette gate.** Colour choices rot silently. Someone adds a category colour, it looks fine on their monitor, and the app has quietly become unreadable for roughly 8% of men. Nobody files that bug — they stop using the app. Computing ΔE in OKLab under simulated protanopia turns an invisible regression into a failed build.

**The SQL policy tests.** RLS fails silently in both directions: too permissive leaks data with no error, too restrictive makes rows vanish with no error. The only way to catch either is a test that authenticates as a *different user* and asserts on what comes back — impossible from application tests that always run as the same session.

---

## 8. Out of scope for phase 1

Budgets · scheduled transactions · multi-currency conversion and the all-wallets overview · shared wallet invites and realtime · CSV import/export · bulk edit · receipt AI scan · PWA install and offline · passcode / biometric lock · bank account connections (out of scope for all phases — requires a paid aggregator).

Phase 1 leaves the schema seams for the first six.

---

## 9. Deployment

Vercel Hobby + Supabase free tier, ~$0/month at personal scale. Supabase's free database pauses after roughly a week of inactivity; Pro is $25/month. The Claude API cost for phase 3's receipt scanning is roughly $0.30–1.40 per 100 receipts depending on model, and does not apply to phase 1.
