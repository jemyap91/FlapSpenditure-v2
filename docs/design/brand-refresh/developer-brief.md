## Developer brief: brand and UI refresh ("Cherry Cola")

Follow-up to point 12 (design) and point 11 (usability) above. Cheryl and Claude worked through four design rounds. This is the agreed direction, written up for building.

**Nothing in the app has been changed.** The mockups live on branch `claude/dazzling-cannon-2xs1mn` in `docs/design/brand-refresh/` (open `index.html` locally). Cheryl will share the interactive page and a PDF separately.

---

### 1. The thinking

Expenses now arrive two ways: added by hand, or logged by Claude through the MCP connector. So the app's main jobs are:

1. **Log it:** manual entry stays first-class. The + stays centre of the tab bar.
2. **Check it:** confirm what Claude logged, catch duplicates, see pace against budget.
3. **Choose the card:** which card to use next across both of us, and when bills are due.

---

### 2. Design system

**Colours** (replaces the current categorical palette for UI chrome; light mode only for now, dark mode later)

| Token | Hex | Use |
|---|---|---|
| Oxblood | `#4A0D1E` | One hero block per screen, tab bar, primary buttons |
| Oxblood deep | `#651528` | Decorative circle on the hero |
| Cream | `#F4ECE0` | Page, and numbers on oxblood |
| Card | `#FBF5EC` | Surfaces |
| Oat | `#EADFCF` | Tracks, dividers, neutral icon tiles |
| Ink | `#2A0E17` | Text |
| Ink 2 | `#765F66` | Secondary text |
| Candy | `#FF8DB8` (tint `#FFE0EC`) | Cheryl, the + button |
| Cobalt | `#2B44FF` (tint `#DDE1FF`) | Jeremy, links |
| Butter | `#FFD36B` (tint `#FFF1CC`) | Shared, highlights, goals hit, "needs a look" |
| Cherry | `#E0243A` (tint `#FBD7DB`) | Over budget, near a cap, low balance. Nothing else. |

Rules:
- Colour means **who** (owner) or **status** only. Categories are told apart by icon, on neutral oat tiles.
- Numbers on oxblood are cream. Never pink.
- One oxblood block per screen.
- No borders or outlines. Separation by fill and spacing. Soft shadow only on floating things.

Where it lands: `palette.json`, the tokens in `src/app/globals.css`, and `scripts/validate-palette.mjs` (the contrast checks will need the new pairs).

**Type** (replaces Geist in `src/app/layout.tsx`, via `next/font/google`)
- **Unbounded** 700–800: screen titles, section heads, and the one hero number per screen.
- **Manrope** 500–800: everything else, including all list amounts, with `font-variant-numeric: tabular-nums`.

---

### 3. Navigation

`src/components/shell/TabBar.tsx`:

- **Today:** Home · Wallets · Activity · Budgets · Categories
- **Proposed:** Home · Activity · **+** · Cards · Wallets

Budgets fold into Home. Categories, Recurring, Household, API access and the new Claude instructions move to a profile menu.

---

### 4. Screens

Data notes mark what already exists (✅) and what is new (🆕).

**Home**
- Hero shows the month's spend plus a **pace marker**: where spend should be by today, and "S$X under/over pace". ✅ Budget and month range exist, so this is a pure calculation.
- **"Needs a look"** strip: Claude-logged entries to confirm, likely duplicates, and recurring items due. ✅ `DueList` / `due-rows.ts` already work out due and handled occurrences. 🆕 "Logged by" and review state (see 5.1).
- **Budget rings** replace the Budgets tab on mobile. ✅ `BudgetSummary` data.
- **One card alert** (the card closest to a deadline). ✅ `loadCardTracker`.
- Owner filter chips: All · Cheryl · Jeremy · Shared.

**Add expense**
- Still a full screen, with Expense / Income / Transfer tabs and the keypad.
- **Merchant memory:** picking a merchant offers last time's category *and card*. ✅ `0026_entry_suggestions` already returns category. 🆕 Also return the wallet.
- **Card suggestion:** "Best card for this", across both partners' cards. 🆕 Ranking function (5.3).
- **Split with Jeremy** toggle. ✅ Split parts exist; check whether the form can create one in a single step.

**Activity**
- **"Logged by" tag** on every row: Claude, App or Recurring. 🆕
- **Filters:** Needs review · Cheryl · Jeremy · Shared · No bonus (✅ mismatch logic exists in the connector).
- **Transfers read "POSB → PayLah"** with direction (issue point 2).
- **List or calendar view** with daily totals. 🆕 Calendar is optional.

**Cards** (new tab)
- **"Use next"** hero, then every card across both partners ranked, with cycle progress. ✅ Min spend (`0034`), caps and channels (`0033`), cycle via `loadCardTracker`. 🆕 Ranking is new but can be a pure function over existing rows.
- Cards near their cap are flagged "Avoid" in cherry.
- **Bills:** amount, due date, paying account. 🆕 Needs new card fields (5.6).

**Wallets**
- **Grouped Shared · Cheryl · Jeremy**, with owner badges, so "(C)" and "(J)" can leave the names (issue point 5). ✅ `wallets.owner_id` and household sharing (`0024`/`0025`). Shared = wallets with both of us as members; please confirm that rule.
- **Balance on every account** (issue point 1).
- **Low-balance nudge** on PayLah, with a one-tap "Top up from POSB" (issue point 10).
- Cards collapse to one row linking to the Cards tab.

**Hero states:** the Home hero turns cherry when over budget and butter when a goal is hit. These are the only colour changes to the oxblood block.

---

### 5. New functions, ranked

1. **Review inbox.** 🆕 `created_via` on transactions (`app` / `claude` / `recurring`, set by the API-token path from `0028`, the recurring job and the form), plus `reviewed_at`. Manual entries are created already reviewed.
2. **Duplicate guard.** Warn when a new entry matches a recurring occurrence (same merchant, similar amount, within a few days). ✅ Reuses the handled-occurrence logic in `due-rows.ts`.
3. **"Which card?" across both partners.** A pure ranking over card tracker rows: below min spend first, then bonus room, avoid near-cap.
4. **Settle up.** A running "who owes whom" from split parts and repayments, with a one-tap repayment. ✅ Data exists. 🆕 Aggregate and UI.
5. **Instructions for Claude.** A per-user preferences record the MCP server returns automatically (issue point 9). 🆕 Small table and one MCP change.
6. **Bill radar.** 🆕 Card fields: statement day, due day, pay-from wallet. Shown on Cards and as a "bills this week" strip on Home.

Still open from this issue: recurring transfers (6), delete vs pause (7), and copying the rule's merchant and note onto entries (8).

---

### 6. Suggested order

- **Phase 1, look and feel:** tokens, fonts, tab bar and profile menu, restyle existing screens. No schema changes.
- **Phase 2, quick wins on existing data:** owner grouping, Cards tab and ranking, pace marker, budget rings, merchant memory with wallet, transfer direction.
- **Phase 3, new data:** `created_via` and the review inbox, duplicate guard, bills, settle up, Claude instructions.

---

### 7. Not in scope yet

- **Dark mode:** the palette needs a dark pass later.
- **Mascot (Flapjack, "Flappy"):** being designed separately. The mockups show dashed placeholders where it will sit.

### Questions for Jeremy

1. Is "Shared = wallet with both of us as members" the right rule, or should there be an explicit flag?
2. Can the MCP path set `created_via` reliably from the API token, or does it need an explicit parameter?
3. Any of Phase 2 harder than it looks with the current data?
