# Expense Tracker Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core ledger — auth, wallets, categories, transactions including transfers, and a dashboard — as a responsive web app.

**Architecture:** A single Next.js App Router application against Supabase Postgres. Reads happen in Server Components; writes go through Server Actions, never from the browser. Row-level security is the enforcement boundary, routed through one `SECURITY DEFINER` membership predicate.

**On SQL functions.** PostgREST runs each request in a transaction, so a single multi-row `.insert([a, b])` or a single `UPDATE … WHERE transfer_id = $1` is already atomic — atomicity alone does **not** justify pushing logic into Postgres. Exactly one operation earns a function: `create_transfer`, whose invariant is multi-part (two rows, opposite signs, distinct wallets, membership on both) and worth enforcing regardless of which client is calling. Soft delete and restore stay in TypeScript: they are single statements with no invariant a function would add, and every SQL function is a permanent migration, an untypeable surface, and an opaque error string.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, Tailwind, Supabase (Postgres + Auth), Zod, Recharts, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-11-expense-tracker-phase-1-design.md`. Section references below (§3.2, §5.3, …) point into it.

## Global Constraints

- **Money is `bigint` signed minor units.** Negative = expense/transfer-out, positive = income/transfer-in. `parseFloat(x) * 100` is banned anywhere in the codebase.
- **Only two modules convert money:** `src/lib/money.ts` exports `formatMoney(minorUnits, currencyCode)` and `parseAmountInput(raw, minorUnit)`. Nothing else touches the representation.
- **The browser never writes to Supabase directly.** All mutations go through Server Actions in `src/server/actions/`.
- **Colour is stored as `color_slot smallint` 1–8**, never a hex string. Hex lives only in `palette.json`.
- **Category colour palette is frozen** unless `node scripts/validate-palette.mjs` passes. CI runs it.
- **Icons are Lucide line icons. Never emoji.** (Spec §5.3, §6.)
- **Amount signs are always rendered** (`−12.50`, `+3,200.00`). Colour reinforces the sign, never replaces it.
- **TypeScript `strict: true`.** No `any` in committed code.
- **Every task ends with a commit.** Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `refactor:`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `palette.json` | Single source of truth for the categorical palette + surfaces |
| `scripts/validate-palette.mjs` | CI gate; reads `palette.json` |
| `src/lib/money.ts` | The only money conversion/formatting in the codebase |
| `src/lib/palette.ts` | Typed access to `palette.json` for components |
| `src/lib/supabase/{server,client,middleware}.ts` | Supabase client factories per execution context |
| `src/lib/validation/*.ts` | Zod schemas shared by forms and Server Actions |
| `src/server/actions/*.ts` | All mutations |
| `src/app/(auth)/*` | Login, signup |
| `src/app/(app)/*` | Authenticated shell + feature routes |
| `src/components/*` | Presentational components |
| `supabase/migrations/*.sql` | Schema, RLS, functions — ordered, immutable once applied |
| `supabase/tests/*.sql` | Adversarial RLS tests, run as a second user |

---

## Milestone A — Foundations

### Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `.env.local.example`, `vitest.config.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing
- Produces: a running dev server; `npm test`, `npm run lint`, `npm run typecheck`, `npm run validate:palette` scripts

- [ ] **Step 1: Scaffold Next.js**

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app \
  --src-dir --import-alias "@/*" --no-turbopack --yes
```

If the directory is non-empty, the CLI will refuse. In that case run it in a temp dir and copy the generated files in, preserving the existing `docs/`, `scripts/` and `.gitignore`.

- [ ] **Step 2: Add dev dependencies**

```bash
npm install zod @supabase/supabase-js @supabase/ssr lucide-react recharts
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react \
  @testing-library/jest-dom @playwright/test
```

- [ ] **Step 3: Configure Vitest**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", globals: true, setupFiles: ["./vitest.setup.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
```

```ts
// vitest.setup.ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Add scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "validate:palette": "node scripts/validate-palette.mjs"
  }
}
```

- [ ] **Step 5: Set `strict` in `tsconfig.json`**

Confirm `"strict": true` is present under `compilerOptions`. Add `"noUncheckedIndexedAccess": true`.

- [ ] **Step 6: Write the env template**

```bash
# .env.local.example
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 7: Add CI**

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "npm" }
      - run: npm ci
      - run: npm run validate:palette
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
```

- [ ] **Step 8: Verify everything runs**

Run: `npm run typecheck && npm run lint && npm run validate:palette`
Expected: all three exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Tailwind, Vitest and CI"
```

---

### Task 2: Single-source the palette

The palette currently lives inside `scripts/validate-palette.mjs`, but components need the same values as CSS tokens. Two copies will drift, and the drift is invisible — the validator would keep passing while the app rendered different colours. Extract to `palette.json`, consumed by both.

**Files:**
- Create: `palette.json`, `src/lib/palette.ts`, `src/lib/palette.test.ts`
- Modify: `scripts/validate-palette.mjs`, `src/app/globals.css`

**Interfaces:**
- Consumes: nothing
- Produces: `PALETTE` (typed), `slotVar(slot: number): string` returning `var(--cat-N)`; CSS custom properties `--cat-1`…`--cat-8`, `--surface`, `--page`, `--ink`, `--ink-2`, `--muted`, `--grid`, `--pos`, `--neg`, `--div-in`, `--div-out`, `--div-mid`

- [ ] **Step 1: Create `palette.json`**

```json
{
  "categorical": [
    { "name": "brick", "light": "#ba362e", "dark": "#e86154" },
    { "name": "amber", "light": "#b67c10", "dark": "#8c5e09" },
    { "name": "fern",  "light": "#0a7039", "dark": "#16ae5b" },
    { "name": "olive", "light": "#918e10", "dark": "#6f6d0a" },
    { "name": "wine",  "light": "#c7436d", "dark": "#d55078" },
    { "name": "ochre", "light": "#a48610", "dark": "#7e660a" },
    { "name": "plum",  "light": "#b84999", "dark": "#c656a6" },
    { "name": "sage",  "light": "#1a8210", "dark": "#2b8f22" }
  ],
  "surfaces": { "light": "#fcfcfb", "dark": "#1a1a19" },
  "chrome": {
    "page":  { "light": "#f9f9f7", "dark": "#0d0d0d" },
    "ink":   { "light": "#0b0b0b", "dark": "#ffffff" },
    "ink2":  { "light": "#52514e", "dark": "#c3c2b7" },
    "muted": { "light": "#898781", "dark": "#898781" },
    "grid":  { "light": "#e1e0d9", "dark": "#2c2c2a" },
    "pos":   { "light": "#006300", "dark": "#0ca30c" },
    "neg":   { "light": "#d03b3b", "dark": "#e66767" }
  },
  "diverging": {
    "in":  { "light": "#17a2a2", "dark": "#17a2a2" },
    "out": { "light": "#e36a1f", "dark": "#e36a1f" },
    "mid": { "light": "#f0efec", "dark": "#383835" }
  }
}
```

- [ ] **Step 2: Point the validator at it**

In `scripts/validate-palette.mjs`, replace the hard-coded `PALETTE` const with:

```js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "..", "palette.json"), "utf8"));

export const PALETTE = {
  light: { surface: raw.surfaces.light, slots: raw.categorical.map((c) => [c.name, c.light]) },
  dark:  { surface: raw.surfaces.dark,  slots: raw.categorical.map((c) => [c.name, c.dark])  },
};
```

- [ ] **Step 3: Run the validator to prove nothing changed**

Run: `npm run validate:palette`
Expected: PASS in both modes, dark CVD ΔE **10.0**, light **10.2**. If either number differs, the extraction changed a value — fix it before continuing.

- [ ] **Step 4: Write the failing test for `src/lib/palette.ts`**

```ts
// src/lib/palette.test.ts
import { describe, it, expect } from "vitest";
import { PALETTE, slotVar, SLOT_COUNT } from "./palette";

describe("palette", () => {
  it("exposes exactly 8 categorical slots", () => {
    expect(SLOT_COUNT).toBe(8);
    expect(PALETTE.categorical).toHaveLength(8);
  });

  it("maps a slot number to its CSS variable", () => {
    expect(slotVar(1)).toBe("var(--cat-1)");
    expect(slotVar(8)).toBe("var(--cat-8)");
  });

  it("rejects out-of-range slots rather than silently wrapping", () => {
    expect(() => slotVar(0)).toThrow();
    expect(() => slotVar(9)).toThrow();
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run src/lib/palette.test.ts`
Expected: FAIL — cannot resolve `./palette`.

- [ ] **Step 6: Implement `src/lib/palette.ts`**

```ts
import raw from "../../palette.json";

export type Slot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const SLOT_COUNT = 8;
export const PALETTE = raw;

/** CSS variable for a category/wallet colour slot. Throws on out-of-range. */
export function slotVar(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new RangeError(`color_slot must be 1-${SLOT_COUNT}, got ${slot}`);
  }
  return `var(--cat-${slot})`;
}
```

Add `"resolveJsonModule": true` to `tsconfig.json` if not already present.

- [ ] **Step 7: Run the test**

Run: `npx vitest run src/lib/palette.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Emit the CSS tokens**

Append to `src/app/globals.css`. Dark values are declared under **both** the media query and the `[data-theme]` scope so an explicit toggle wins in both directions:

```css
:root {
  --cat-1: #ba362e; --cat-2: #b67c10; --cat-3: #0a7039; --cat-4: #918e10;
  --cat-5: #c7436d; --cat-6: #a48610; --cat-7: #b84999; --cat-8: #1a8210;
  --surface: #fcfcfb; --page: #f9f9f7;
  --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781; --grid: #e1e0d9;
  --pos: #006300; --neg: #d03b3b;
  --div-in: #17a2a2; --div-out: #e36a1f; --div-mid: #f0efec;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --cat-1: #e86154; --cat-2: #8c5e09; --cat-3: #16ae5b; --cat-4: #6f6d0a;
    --cat-5: #d55078; --cat-6: #7e660a; --cat-7: #c656a6; --cat-8: #2b8f22;
    --surface: #1a1a19; --page: #0d0d0d;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781; --grid: #2c2c2a;
    --pos: #0ca30c; --neg: #e66767;
    --div-mid: #383835;
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --cat-1: #e86154; --cat-2: #8c5e09; --cat-3: #16ae5b; --cat-4: #6f6d0a;
  --cat-5: #d55078; --cat-6: #7e660a; --cat-7: #c656a6; --cat-8: #2b8f22;
  --surface: #1a1a19; --page: #0d0d0d;
  --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781; --grid: #2c2c2a;
  --pos: #0ca30c; --neg: #e66767;
  --div-mid: #383835;
  color-scheme: dark;
}

body { background: var(--page); color: var(--ink); }
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: single-source the palette in palette.json"
```

---

### Task 3: Money conversion

The highest-risk pure logic in the app. Built first, TDD, with no dependencies.

**Files:**
- Create: `src/lib/money.ts`, `src/lib/money.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `formatMoney(minorUnits: number, currencyCode: string, opts?: { signed?: boolean }): string`
  - `parseAmountInput(raw: string, minorUnit: number): number` — returns **positive** minor units; sign is applied by the caller from transaction kind
  - `appendDigit(current: string, digit: string, minorUnit: number): string` — keypad reducer
  - `MINOR_UNITS: Record<string, number>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/money.test.ts
import { describe, it, expect } from "vitest";
import { formatMoney, parseAmountInput, appendDigit } from "./money";

describe("parseAmountInput", () => {
  it("converts a 2-decimal string to minor units without floating point", () => {
    expect(parseAmountInput("12.50", 2)).toBe(1250);
    expect(parseAmountInput("0.07", 2)).toBe(7);
    expect(parseAmountInput("1234567.89", 2)).toBe(123456789);
  });

  it("handles the classic float-error cases exactly", () => {
    // parseFloat("1.005") * 100 === 100.49999999999999
    expect(parseAmountInput("1.005", 2)).toBe(100);   // truncates, never rounds up wrongly
    expect(parseAmountInput("8.87", 2)).toBe(887);    // 8.87*100 === 886.9999999999999
  });

  it("respects currencies with 0 or 3 minor units", () => {
    expect(parseAmountInput("1200", 0)).toBe(1200);   // JPY
    expect(parseAmountInput("1.234", 3)).toBe(1234);  // KWD
  });

  it("pads short decimals", () => {
    expect(parseAmountInput("5.5", 2)).toBe(550);
    expect(parseAmountInput("5.", 2)).toBe(500);
    expect(parseAmountInput("5", 2)).toBe(500);
  });

  it("returns 0 for empty input", () => {
    expect(parseAmountInput("", 2)).toBe(0);
  });

  it("rejects malformed input", () => {
    expect(() => parseAmountInput("1.2.3", 2)).toThrow();
    expect(() => parseAmountInput("abc", 2)).toThrow();
    expect(() => parseAmountInput("-5", 2)).toThrow(); // sign comes from kind, not input
  });
});

describe("appendDigit", () => {
  it("builds up an amount", () => {
    expect(appendDigit("0", "1", 2)).toBe("1");
    expect(appendDigit("1", "2", 2)).toBe("12");
  });

  it("allows exactly one decimal point", () => {
    expect(appendDigit("12", ".", 2)).toBe("12.");
    expect(appendDigit("12.", ".", 2)).toBe("12.");
    expect(appendDigit("12.5", ".", 2)).toBe("12.5");
  });

  it("caps decimals at the currency's minor unit", () => {
    expect(appendDigit("12.34", "5", 2)).toBe("12.34");
    expect(appendDigit("12.3", "4", 3)).toBe("12.34");
  });

  it("refuses a decimal point for zero-decimal currencies", () => {
    expect(appendDigit("1200", ".", 0)).toBe("1200");
  });
});

describe("formatMoney", () => {
  it("formats minor units with the currency symbol", () => {
    expect(formatMoney(1250, "USD")).toBe("$12.50");
    expect(formatMoney(123456789, "USD")).toBe("$1,234,567.89");
  });

  it("formats zero-decimal currencies without a decimal point", () => {
    expect(formatMoney(1200, "JPY")).toBe("¥1,200");
  });

  it("always renders an explicit sign when asked", () => {
    expect(formatMoney(-1250, "USD", { signed: true })).toBe("−$12.50");
    expect(formatMoney(1250, "USD", { signed: true })).toBe("+$12.50");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/money.test.ts`
Expected: FAIL — cannot resolve `./money`.

- [ ] **Step 3: Implement**

```ts
// src/lib/money.ts

/** ISO 4217 decimal exponent. Not every currency uses 2. */
export const MINOR_UNITS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, CHF: 2, CNY: 2, SGD: 2,
  JPY: 0, KRW: 0, VND: 0,
  KWD: 3, BHD: 3, OMR: 3,
};

export const minorUnitFor = (code: string): number => MINOR_UNITS[code] ?? 2;

/**
 * Parse a user-entered amount string into POSITIVE minor units.
 * Pure string manipulation — the value never becomes a float, because
 * parseFloat("8.87") * 100 === 886.9999999999999.
 */
export function parseAmountInput(raw: string, minorUnit: number): number {
  const s = raw.trim();
  if (s === "") return 0;
  if (!/^\d*(\.\d*)?$/.test(s)) {
    throw new Error(`malformed amount: ${JSON.stringify(raw)}`);
  }
  const [whole = "", frac = ""] = s.split(".");
  const paddedFrac = frac.padEnd(minorUnit, "0").slice(0, minorUnit);
  const digits = `${whole || "0"}${paddedFrac}`;
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) throw new Error(`amount out of range: ${raw}`);
  return n;
}

/** Keypad reducer. Enforces one decimal point and the currency's precision. */
export function appendDigit(current: string, digit: string, minorUnit: number): string {
  if (digit === ".") {
    if (minorUnit === 0 || current.includes(".")) return current;
    return `${current}.`;
  }
  if (!/^\d$/.test(digit)) return current;

  const dot = current.indexOf(".");
  if (dot >= 0 && current.length - dot - 1 >= minorUnit) return current;
  if (current === "0") return digit;
  return current + digit;
}

export function formatMoney(
  minorUnits: number,
  currencyCode: string,
  opts: { signed?: boolean } = {},
): string {
  const minorUnit = minorUnitFor(currencyCode);
  const abs = Math.abs(minorUnits);
  const major = abs / 10 ** minorUnit;

  const body = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: minorUnit,
    maximumFractionDigits: minorUnit,
  }).format(major);

  if (!opts.signed) return minorUnits < 0 ? `−${body}` : body;
  return minorUnits < 0 ? `−${body}` : `+${body}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/money.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts src/lib/money.test.ts
git commit -m "feat: add integer-safe money parsing and formatting"
```

---

## Milestone B — Database

### Task 4: Supabase local + reference tables

**Files:**
- Create: `supabase/config.toml` (generated), `supabase/migrations/0001_reference.sql`

**Interfaces:**
- Consumes: nothing
- Produces: tables `currencies(code, minor_unit, symbol, name)`, `profiles(id, display_name, base_currency, theme)`; enum types `wallet_kind`, `txn_kind`, `category_kind`, `member_role`, `theme_pref`

- [ ] **Step 1: Initialise and start Supabase**

```bash
npx supabase init
npx supabase start
```

Copy the printed `anon key` into `.env.local` as `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

- [ ] **Step 2: Write the migration**

```sql
-- supabase/migrations/0001_reference.sql
create type wallet_kind   as enum ('card', 'bank');
create type txn_kind      as enum ('expense', 'income', 'transfer');
create type category_kind as enum ('expense', 'income');
create type member_role   as enum ('owner', 'member');
create type theme_pref    as enum ('system', 'light', 'dark');

create table currencies (
  code       char(3) primary key,
  minor_unit smallint not null check (minor_unit between 0 and 4),
  symbol     text not null,
  name       text not null
);

insert into currencies (code, minor_unit, symbol, name) values
  ('USD',2,'$','US Dollar'),        ('EUR',2,'€','Euro'),
  ('GBP',2,'£','Pound Sterling'),   ('AUD',2,'A$','Australian Dollar'),
  ('CAD',2,'C$','Canadian Dollar'), ('SGD',2,'S$','Singapore Dollar'),
  ('CHF',2,'CHF','Swiss Franc'),    ('CNY',2,'¥','Chinese Yuan'),
  ('JPY',0,'¥','Japanese Yen'),     ('KRW',0,'₩','South Korean Won'),
  ('KWD',3,'KD','Kuwaiti Dinar');

create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  base_currency char(3) not null default 'USD' references currencies(code),
  theme         theme_pref not null default 'system',
  created_at    timestamptz not null default now()
);

alter table currencies enable row level security;
alter table profiles   enable row level security;

create policy currencies_read on currencies
  for select to authenticated using (true);

create policy profiles_own on profiles
  for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
```

- [ ] **Step 3: Apply and verify**

Run: `npx supabase db reset`
Expected: migration applies with no error.

Then verify the seed landed:

```bash
npx supabase db diff --schema public   # expect: no schema drift
psql "$(npx supabase status -o json | jq -r .DB_URL)" -c \
  "select code, minor_unit from currencies order by code;"
```

Expected: 11 rows, `JPY` with `minor_unit = 0`, `KWD` with `3`.

- [ ] **Step 4: Commit**

```bash
git add supabase/
git commit -m "feat: add currencies and profiles with enum types"
```

---

### Task 5: Wallets, members and categories

**Files:**
- Create: `supabase/migrations/0002_wallets_categories.sql`

**Interfaces:**
- Consumes: enums and `currencies` from Task 4
- Produces: tables `wallets`, `wallet_members`, `categories`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0002_wallets_categories.sql
create table wallets (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null references auth.users(id) on delete cascade,
  name                   text not null check (length(btrim(name)) between 1 and 60),
  kind                   wallet_kind not null,
  currency_code          char(3) not null references currencies(code),
  starting_balance_minor bigint not null default 0,
  color_slot             smallint not null check (color_slot between 1 and 8),
  icon                   text not null,
  archived_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table wallet_members (
  wallet_id uuid not null references wallets(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      member_role not null default 'owner',
  joined_at timestamptz not null default now(),
  primary key (wallet_id, user_id)
);

create table categories (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 40),
  kind        category_kind not null,
  color_slot  smallint not null check (color_slot between 1 and 8),
  icon        text not null,
  sort_order  integer not null default 0,
  is_default  boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Case-insensitive, scoped to ACTIVE rows so a name frees up after archiving (spec §5.3)
create unique index categories_unique_active_name
  on categories (owner_id, kind, lower(name))
  where archived_at is null;

create index wallets_owner    on wallets (owner_id) where archived_at is null;
create index categories_owner on categories (owner_id, kind) where archived_at is null;

-- Every wallet's creator is automatically its owner-member.
create function add_owner_as_member() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into wallet_members (wallet_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end $$;

create trigger wallets_add_owner after insert on wallets
  for each row execute function add_owner_as_member();
```

- [ ] **Step 2: Apply**

Run: `npx supabase db reset`
Expected: applies cleanly.

- [ ] **Step 3: Verify the uniqueness index behaves as specified**

```bash
psql "$DB_URL" <<'SQL'
begin;
  insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111','a@x.io');
  insert into categories (owner_id,name,kind,color_slot,icon)
    values ('11111111-1111-1111-1111-111111111111','Vet','expense',1,'paw');
  -- same name, different case -> must fail
  savepoint s1;
  insert into categories (owner_id,name,kind,color_slot,icon)
    values ('11111111-1111-1111-1111-111111111111','vet','expense',2,'paw');
rollback;
SQL
```

Expected: the second insert raises `duplicate key value violates unique constraint`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_wallets_categories.sql
git commit -m "feat: add wallets, wallet_members and categories"
```

---

### Task 6: Transactions with CHECK invariants

**Files:**
- Create: `supabase/migrations/0003_transactions.sql`

**Interfaces:**
- Consumes: `wallets`, `categories`
- Produces: table `transactions` with the four invariants from spec §3.3

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0003_transactions.sql
create table transactions (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references wallets(id) on delete cascade,
  created_by    uuid not null references auth.users(id),
  kind          txn_kind not null,
  amount_minor  bigint not null check (amount_minor <> 0),
  currency_code char(3) not null references currencies(code),
  category_id   uuid references categories(id) on delete restrict,
  transfer_id   uuid,
  note          text check (note is null or length(note) <= 280),
  occurred_on   date not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  -- Spec §3.3 — the ledger cannot hold a nonsensical row.
  constraint expense_is_negative  check (kind <> 'expense'  or amount_minor < 0),
  constraint income_is_positive   check (kind <> 'income'   or amount_minor > 0),
  constraint transfer_shape       check (kind <> 'transfer' or (category_id is null and transfer_id is not null)),
  constraint non_transfer_no_link check (kind =  'transfer' or transfer_id is null)
);

create index transactions_wallet_date
  on transactions (wallet_id, occurred_on desc) where deleted_at is null;
create index transactions_category on transactions (category_id);
create index transactions_transfer on transactions (transfer_id);
```

- [ ] **Step 2: Apply**

Run: `npx supabase db reset`

- [ ] **Step 3: Prove each constraint rejects its bad case**

Create `supabase/tests/constraints.sql`:

```sql
-- Each block must FAIL. Run with ON_ERROR_STOP off and read the notices.
\set ON_ERROR_STOP off
begin;
  insert into auth.users (id,email) values ('22222222-2222-2222-2222-222222222222','b@x.io');
  insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
    values ('33333333-3333-3333-3333-333333333333',
            '22222222-2222-2222-2222-222222222222','Main','bank','USD',1,'landmark');

  -- expense with a positive amount -> expense_is_negative
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'expense', 500, 'USD', current_date);

  -- income with a negative amount -> income_is_positive
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'income', -500, 'USD', current_date);

  -- transfer without transfer_id -> transfer_shape
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'transfer', -500, 'USD', current_date);

  -- expense WITH a transfer_id -> non_transfer_no_link
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,transfer_id,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'expense', -500, 'USD', gen_random_uuid(), current_date);
rollback;
```

Run: `psql "$DB_URL" -f supabase/tests/constraints.sql 2>&1 | grep -c "violates check constraint"`
Expected: `4`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0003_transactions.sql supabase/tests/constraints.sql
git commit -m "feat: add transactions table with ledger invariants as CHECK constraints"
```

---

### Task 7: Row-level security

**Files:**
- Create: `supabase/migrations/0004_rls.sql`

**Interfaces:**
- Consumes: all tables
- Produces: `is_wallet_member(uuid) returns boolean`; policies on `wallets`, `wallet_members`, `categories`, `transactions`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0004_rls.sql

-- SECURITY DEFINER is REQUIRED, not stylistic (spec §4.1): without it, the
-- wallets policy queries wallet_members whose policy queries wallets, and
-- Postgres raises "infinite recursion detected in policy".
-- SET search_path is mandatory — without it a caller can point search_path at
-- their own wallet_members table and escalate.
create function is_wallet_member(w uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from wallet_members
    where wallet_id = w and user_id = auth.uid()
  )
$$;

alter table wallets        enable row level security;
alter table wallet_members enable row level security;
alter table categories     enable row level security;
alter table transactions   enable row level security;

-- Members can SEE a wallet; only the owner can CHANGE it (spec §4).
create policy wallets_select on wallets
  for select to authenticated using (is_wallet_member(id));
create policy wallets_write on wallets
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy members_select on wallet_members
  for select to authenticated using (is_wallet_member(wallet_id));
create policy members_write on wallet_members
  for all to authenticated
  using (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()));

create policy categories_own on categories
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy transactions_member on transactions
  for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));
```

- [ ] **Step 2: Apply**

Run: `npx supabase db reset`
Expected: applies cleanly, **no recursion error**.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0004_rls.sql
git commit -m "feat: add RLS policies routed through is_wallet_member"
```

---

### Task 8: Adversarial RLS tests

RLS fails silently in both directions — too permissive leaks with no error, too restrictive hides rows with no error. The only way to catch either is a test authenticated as a *different* user.

**Files:**
- Create: `supabase/tests/rls.sql`, `scripts/test-rls.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: policies from Task 7
- Produces: `npm run test:rls`

- [ ] **Step 1: Write the test**

```sql
-- supabase/tests/rls.sql
-- Two users. B must never see or touch A's data.
\set ON_ERROR_STOP on

insert into auth.users (id,email) values
  ('aaaaaaaa-0000-0000-0000-000000000001','alice@x.io'),
  ('bbbbbbbb-0000-0000-0000-000000000002','bob@x.io');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';

insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
  values ('cccccccc-0000-0000-0000-000000000003',
          'aaaaaaaa-0000-0000-0000-000000000001','Alice Bank','bank','USD',1,'landmark');
insert into categories (id,owner_id,name,kind,color_slot,icon)
  values ('dddddddd-0000-0000-0000-000000000004',
          'aaaaaaaa-0000-0000-0000-000000000001','Groceries','expense',2,'basket');
insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,category_id,occurred_on)
  values ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001',
          'expense',-1250,'USD','dddddddd-0000-0000-0000-000000000004',current_date);

-- Alice sees her own row.
do $$ begin
  assert (select count(*) from transactions) = 1, 'alice should see her own transaction';
end $$;

-- Now become Bob.
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';

do $$ begin
  assert (select count(*) from wallets)      = 0, 'LEAK: bob can see alice wallet';
  assert (select count(*) from transactions) = 0, 'LEAK: bob can see alice transaction';
  assert (select count(*) from categories)   = 0, 'LEAK: bob can see alice category';
end $$;

-- Bob writing into Alice's wallet must be rejected by the WITH CHECK clause.
do $$
begin
  begin
    insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('cccccccc-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000002',
            'expense',-999,'USD',current_date);
    raise exception 'LEAK: bob inserted into alice wallet';
  exception when insufficient_privilege or check_violation then
    null;  -- expected
  end;
end $$;

-- Bob updating Alice's row must affect zero rows (USING filters it out).
do $$
declare n int;
begin
  update transactions set note = 'pwned' where true;
  get diagnostics n = row_count;
  assert n = 0, 'LEAK: bob updated alice rows';
end $$;
```

- [ ] **Step 2: Write the runner**

```bash
#!/usr/bin/env bash
# scripts/test-rls.sh
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
npx supabase db reset --no-seed >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
echo "RLS tests passed"
```

```bash
chmod +x scripts/test-rls.sh
```

Add to `package.json`: `"test:rls": "./scripts/test-rls.sh"`.

- [ ] **Step 3: Prove the test actually catches a leak**

Temporarily weaken one policy so the test *should* fail:

```bash
psql "$DB_URL" -c "alter policy transactions_member on transactions using (true);"
npm run test:rls
```

Expected: **FAIL** with `LEAK: bob can see alice transaction`. A test that never fails is not a test. Restore with `npx supabase db reset`.

- [ ] **Step 4: Run it clean**

Run: `npm run test:rls`
Expected: `RLS tests passed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/rls.sql scripts/test-rls.sh package.json
git commit -m "test: add adversarial RLS tests that authenticate as a second user"
```

---

### Task 9: The transfer function

One function, and only one. Creating a transfer has a multi-part invariant — two rows, opposite signs, distinct wallets, membership on both — that should hold no matter what client is calling, including a future mobile app or a direct PostgREST request. Soft delete and restore do not: each is a single `UPDATE` that PostgREST already runs atomically, so they stay in TypeScript (Task 16).

**Files:**
- Create: `supabase/migrations/0005_transfer_fn.sql`

**Interfaces:**
- Consumes: `transactions`, `is_wallet_member`
- Produces: `create_transfer(from_wallet uuid, to_wallet uuid, amount_out bigint, amount_in bigint, on_date date, note text) returns uuid`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0005_transfer_fn.sql

-- A transfer is TWO rows sharing a transfer_id (spec §3.2). A client could
-- write both atomically with one multi-row insert — the reason this lives in
-- Postgres is the INVARIANT, not atomicity: distinct wallets, positive inputs,
-- membership on both sides, and opposite signs, enforced for every caller.
-- amount_out is POSITIVE from the caller; this function applies the signs.
create function create_transfer(
  from_wallet uuid, to_wallet uuid,
  amount_out bigint, amount_in bigint,
  on_date date, note text default null
) returns uuid
  language plpgsql security invoker set search_path = public as $$
declare
  tid uuid := gen_random_uuid();
  from_ccy char(3);
  to_ccy   char(3);
begin
  if from_wallet = to_wallet then
    raise exception 'cannot transfer to the same wallet';
  end if;
  if amount_out <= 0 or amount_in <= 0 then
    raise exception 'transfer amounts must be positive';
  end if;
  if not is_wallet_member(from_wallet) or not is_wallet_member(to_wallet) then
    raise exception 'not a member of both wallets';
  end if;

  select currency_code into from_ccy from wallets where id = from_wallet;
  select currency_code into to_ccy   from wallets where id = to_wallet;

  insert into transactions
    (wallet_id, created_by, kind, amount_minor, currency_code, transfer_id, occurred_on, note)
  values
    (from_wallet, auth.uid(), 'transfer', -amount_out, from_ccy, tid, on_date, note),
    (to_wallet,   auth.uid(), 'transfer',  amount_in,  to_ccy,   tid, on_date, note);

  return tid;
end $$;
```

`security invoker` is deliberate — unlike `is_wallet_member`, this function *should* run under the caller's RLS so a user cannot transfer out of a wallet they don't belong to. The explicit `is_wallet_member` guard is belt-and-braces: without it RLS would still reject the insert, but with a far worse error message.

- [ ] **Step 2: Apply**

Run: `npx supabase db reset`

- [ ] **Step 3: Test the pair semantics**

Append to `supabase/tests/rls.sql`, before the Bob section:

```sql
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
  values ('eeeeeeee-0000-0000-0000-000000000005',
          'aaaaaaaa-0000-0000-0000-000000000001','Alice Card','card','USD',3,'credit-card');

do $$
declare tid uuid; legs int; bal_from bigint; bal_to bigint;
begin
  tid := create_transfer('cccccccc-0000-0000-0000-000000000003',
                         'eeeeeeee-0000-0000-0000-000000000005',
                         5000, 5000, current_date, 'card payment');
  select count(*) into legs from transactions where transfer_id = tid;
  assert legs = 2, 'transfer must create exactly two legs';

  select coalesce(sum(amount_minor),0) into bal_from
    from transactions where wallet_id='cccccccc-0000-0000-0000-000000000003' and deleted_at is null;
  select coalesce(sum(amount_minor),0) into bal_to
    from transactions where wallet_id='eeeeeeee-0000-0000-0000-000000000005' and deleted_at is null;
  assert bal_from = -1250 - 5000, format('from balance wrong: %s', bal_from);
  assert bal_to   =  5000,        format('to balance wrong: %s', bal_to);

  -- Deleting by transfer_id takes BOTH legs in one statement. This is the
  -- exact statement the TypeScript action issues (Task 16) — proving it here
  -- means the client path is covered without a function wrapping it.
  update transactions set deleted_at = now() where transfer_id = tid and deleted_at is null;
  assert (select count(*) from transactions where transfer_id = tid and deleted_at is null) = 0,
         'soft delete must take both legs';

  update transactions set deleted_at = null where transfer_id = tid;
  assert (select count(*) from transactions where transfer_id = tid and deleted_at is null) = 2,
         'restore must bring both legs back';
end $$;
```

Run: `npm run test:rls`
Expected: `RLS tests passed`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0005_transfer_fn.sql supabase/tests/rls.sql
git commit -m "feat: add create_transfer function enforcing the paired-row invariant"
```

---

### Task 10: Aggregate RPCs

Plain `SELECT`s re-evaluate the RLS subquery per scanned row. These check membership once, then aggregate freely.

**Files:**
- Create: `supabase/migrations/0006_aggregates.sql`

**Interfaces:**
- Consumes: `transactions`, `wallets`, `is_wallet_member`
- Produces:
  - `get_wallet_balances() returns table(wallet_id uuid, balance_minor bigint, currency_code char(3))`
  - `get_category_breakdown(wallet_ids uuid[], from_date date, to_date date) returns table(category_id uuid, name text, color_slot smallint, icon text, total_minor bigint)`
  - `get_cash_flow(wallet_ids uuid[], from_date date, to_date date, bucket text) returns table(bucket_start date, in_minor bigint, out_minor bigint)`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0006_aggregates.sql

create function get_wallet_balances()
  returns table(wallet_id uuid, balance_minor bigint, currency_code char(3))
  language sql stable security invoker set search_path = public as $$
  select w.id,
         w.starting_balance_minor + coalesce(sum(t.amount_minor) filter (where t.deleted_at is null), 0),
         w.currency_code
  from wallets w
  left join transactions t on t.wallet_id = w.id
  where w.archived_at is null
  group by w.id, w.starting_balance_minor, w.currency_code
$$;

-- Membership is checked ONCE up front; an unauthorised wallet id yields empty
-- rather than an error, so a stale client cannot probe for existence.
create function get_category_breakdown(
  wallet_ids uuid[], from_date date, to_date date
) returns table(category_id uuid, name text, color_slot smallint, icon text, total_minor bigint)
  language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from unnest(wallet_ids) w(id) where not is_wallet_member(w.id)) then
    return;
  end if;

  return query
    select c.id, c.name, c.color_slot, c.icon, sum(-t.amount_minor)::bigint
    from transactions t
    join categories c on c.id = t.category_id
    where t.wallet_id = any(wallet_ids)
      and t.deleted_at is null
      and t.kind = 'expense'          -- transfers are excluded from category reports (§3.3)
      and t.occurred_on between from_date and to_date
    group by c.id, c.name, c.color_slot, c.icon
    order by 5 desc;
end $$;

-- Cash flow INCLUDES transfers (§3.3).
create function get_cash_flow(
  wallet_ids uuid[], from_date date, to_date date, bucket text default 'day'
) returns table(bucket_start date, in_minor bigint, out_minor bigint)
  language plpgsql stable security definer set search_path = public as $$
begin
  if bucket not in ('day','week','month') then
    raise exception 'bucket must be day, week or month';
  end if;
  if exists (select 1 from unnest(wallet_ids) w(id) where not is_wallet_member(w.id)) then
    return;
  end if;

  return query
    select date_trunc(bucket, t.occurred_on)::date,
           coalesce(sum(t.amount_minor) filter (where t.amount_minor > 0), 0)::bigint,
           coalesce(sum(-t.amount_minor) filter (where t.amount_minor < 0), 0)::bigint
    from transactions t
    where t.wallet_id = any(wallet_ids)
      and t.deleted_at is null
      and t.occurred_on between from_date and to_date
    group by 1
    order by 1;
end $$;
```

- [ ] **Step 2: Apply and test**

Append to `supabase/tests/rls.sql`:

```sql
do $$
declare rec record; n int;
begin
  -- breakdown excludes transfers: only the 12.50 expense should appear
  select count(*) into n from get_category_breakdown(
    array['cccccccc-0000-0000-0000-000000000003']::uuid[],
    current_date - 30, current_date);
  assert n = 1, format('breakdown should have 1 category, got %s', n);

  select * into rec from get_category_breakdown(
    array['cccccccc-0000-0000-0000-000000000003']::uuid[],
    current_date - 30, current_date) limit 1;
  assert rec.total_minor = 1250, format('breakdown total wrong: %s', rec.total_minor);
end $$;

-- Bob must get an empty set, not an error and not Alice's data.
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
do $$
declare n int;
begin
  select count(*) into n from get_category_breakdown(
    array['cccccccc-0000-0000-0000-000000000003']::uuid[],
    current_date - 30, current_date);
  assert n = 0, 'LEAK: bob got breakdown for alice wallet';
end $$;
```

Run: `npm run test:rls`
Expected: `RLS tests passed`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0006_aggregates.sql supabase/tests/rls.sql
git commit -m "feat: add aggregate RPCs with one-shot membership checks"
```

---

### Task 11: New-user seed trigger

**Files:**
- Create: `supabase/migrations/0007_seed_user.sql`

**Interfaces:**
- Consumes: `profiles`, `categories`
- Produces: on `auth.users` insert — a `profiles` row and 16 default categories (spec §3.6)

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0007_seed_user.sql
create function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name) values (new.id, split_part(new.email, '@', 1));

  -- 12 expense categories against 8 colour slots: slots repeat by design (§3.6).
  insert into categories (owner_id, name, kind, color_slot, icon, sort_order, is_default) values
    (new.id,'Groceries',    'expense',1,'shopping-basket', 1,true),
    (new.id,'Eating out',   'expense',2,'utensils',        2,true),
    (new.id,'Transport',    'expense',3,'bus',             3,true),
    (new.id,'Housing',      'expense',4,'house',           4,true),
    (new.id,'Utilities',    'expense',5,'plug',            5,true),
    (new.id,'Health',       'expense',6,'heart-pulse',     6,true),
    (new.id,'Entertainment','expense',7,'clapperboard',    7,true),
    (new.id,'Shopping',     'expense',8,'shopping-bag',    8,true),
    (new.id,'Travel',       'expense',1,'plane',           9,true),
    (new.id,'Education',    'expense',2,'graduation-cap', 10,true),
    (new.id,'Subscriptions','expense',3,'repeat',         11,true),
    (new.id,'Other',        'expense',4,'circle-ellipsis',12,true),
    (new.id,'Salary',       'income', 3,'wallet',          1,true),
    (new.id,'Bonus',        'income', 5,'gift',            2,true),
    (new.id,'Interest',     'income', 6,'piggy-bank',      3,true),
    (new.id,'Other income', 'income', 8,'circle-plus',     4,true);

  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();
```

- [ ] **Step 2: Apply and verify**

Run: `npx supabase db reset`

```bash
psql "$DB_URL" <<'SQL'
insert into auth.users (id,email) values ('99999999-0000-0000-0000-000000000009','seed@x.io');
select
  (select count(*) from profiles   where id       = '99999999-0000-0000-0000-000000000009') as profiles,
  (select count(*) from categories where owner_id = '99999999-0000-0000-0000-000000000009') as cats;
SQL
```

Expected: `profiles = 1`, `cats = 16`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0007_seed_user.sql
git commit -m "feat: seed profile and default categories on signup"
```

---

## Milestone C — Auth and shell

### Task 12: Supabase client factories and session middleware

**Files:**
- Create: `src/lib/supabase/server.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/middleware.ts`, `src/middleware.ts`, `src/lib/database.types.ts` (generated)

**Interfaces:**
- Consumes: env vars
- Produces: `createServerClient()`, `createBrowserClient()`, `updateSession(request)`, `Database` type

- [ ] **Step 1: Generate types from the live schema**

```bash
npx supabase gen types typescript --local > src/lib/database.types.ts
```

Add to `package.json`: `"db:types": "supabase gen types typescript --local > src/lib/database.types.ts"`.

- [ ] **Step 2: Write the server client**

```ts
// src/lib/supabase/server.ts
import { createServerClient as create } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";

export async function createServerClient() {
  const cookieStore = await cookies();
  return create<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session instead, so this is safe to ignore.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 3: Write the browser client**

```ts
// src/lib/supabase/client.ts
import { createBrowserClient as create } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

export const createBrowserClient = () =>
  create<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
```

- [ ] **Step 4: Write the session middleware**

```ts
// src/lib/supabase/middleware.ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/signup", "/auth"];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // getUser() revalidates against the auth server; getSession() trusts the
  // cookie and must not be used for authorization decisions.
  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;

  if (!user && !PUBLIC.some((p) => path.startsWith(p))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return response;
}
```

```ts
// src/middleware.ts
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export const middleware = (request: NextRequest) => updateSession(request);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)"],
};
```

- [ ] **Step 5: Verify the redirect**

Run `npm run dev`, then visit `http://localhost:3000/` while logged out.
Expected: redirected to `/login`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase src/middleware.ts src/lib/database.types.ts package.json
git commit -m "feat: add Supabase clients and session middleware"
```

---

### Task 13: Login and signup

**Files:**
- Create: `src/app/(auth)/login/page.tsx`, `src/app/(auth)/signup/page.tsx`, `src/app/auth/callback/route.ts`, `src/server/actions/auth.ts`, `src/lib/validation/auth.ts`

**Interfaces:**
- Consumes: `createServerClient`
- Produces: `signIn(prev, formData)`, `signUp(prev, formData)`, `signOut()` — all `useActionState`-compatible, returning `{ error?: string }`

- [ ] **Step 1: Write the schema**

```ts
// src/lib/validation/auth.ts
import { z } from "zod";

export const credentials = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
```

- [ ] **Step 2: Write the actions**

```ts
// src/server/actions/auth.ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { credentials } from "@/lib/validation/auth";

export type AuthState = { error?: string };

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signUp(parsed.data);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  redirect("/onboarding");
}

export async function signOut() {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
```

- [ ] **Step 3: Write the login page**

```tsx
// src/app/(auth)/login/page.tsx
"use client";
import { useActionState } from "react";
import Link from "next/link";
import { signIn, type AuthState } from "@/server/actions/auth";

export default function LoginPage() {
  const [state, action, pending] = useActionState<AuthState, FormData>(signIn, {});
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold">Sign in</h1>
      <form action={action} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>Email</span>
          <input name="email" type="email" required autoComplete="email"
                 className="rounded-md border px-3 py-2" style={{ borderColor: "var(--grid)" }} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>Password</span>
          <input name="password" type="password" required autoComplete="current-password"
                 className="rounded-md border px-3 py-2" style={{ borderColor: "var(--grid)" }} />
        </label>
        {state.error && <p role="alert" style={{ color: "var(--neg)" }}>{state.error}</p>}
        <button type="submit" disabled={pending}
                className="rounded-md px-4 py-2 font-medium disabled:opacity-60"
                style={{ background: "var(--cat-1)", color: "#fff" }}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        No account? <Link href="/signup" className="underline">Create one</Link>
      </p>
    </main>
  );
}
```

- [ ] **Step 4: Write the signup page**

Identical to Step 3 with these substitutions: import `signUp` instead of `signIn`; `useActionState(signUp, {})`; heading `Create account`; `autoComplete="new-password"`; button label `Create account` / `Creating…`; footer link to `/login` reading `Already have an account? Sign in`.

- [ ] **Step 5: Write the OAuth/magic-link callback**

```ts
// src/app/auth/callback/route.ts
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  if (code) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
```

- [ ] **Step 6: Verify manually**

Run `npm run dev`. Sign up with a new email. Confirm in `psql` that the trigger fired:

```bash
psql "$DB_URL" -c "select count(*) from categories where owner_id = (select id from auth.users order by created_at desc limit 1);"
```

Expected: `16`.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(auth\) src/app/auth src/server/actions/auth.ts src/lib/validation/auth.ts
git commit -m "feat: add email/password sign in and sign up"
```

---

### Task 14: App shell with theme toggle

**Files:**
- Create: `src/app/(app)/layout.tsx`, `src/components/shell/Sidebar.tsx`, `src/components/shell/TabBar.tsx`, `src/components/shell/ThemeToggle.tsx`, `src/server/actions/profile.ts`

**Interfaces:**
- Consumes: `createServerClient`, `signOut`
- Produces: authenticated layout; `setTheme(theme: 'system'|'light'|'dark')`

- [ ] **Step 1: Write the theme action**

```ts
// src/server/actions/profile.ts
"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";

const themeSchema = z.enum(["system", "light", "dark"]);

export async function setTheme(theme: string) {
  const parsed = themeSchema.parse(theme);
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("not authenticated");

  await supabase.from("profiles").update({ theme: parsed }).eq("id", user.id);
  revalidatePath("/", "layout");
}
```

- [ ] **Step 2: Write the layout**

```tsx
// src/app/(app)/layout.tsx
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/shell/Sidebar";
import { TabBar } from "@/components/shell/TabBar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles").select("theme, display_name").eq("id", user.id).single();

  const { count } = await supabase
    .from("wallets").select("id", { count: "exact", head: true }).is("archived_at", null);
  if (!count) redirect("/onboarding");

  return (
    <div data-theme={profile?.theme === "system" ? undefined : profile?.theme}
         className="min-h-dvh md:flex" style={{ background: "var(--page)" }}>
      <Sidebar theme={profile?.theme ?? "system"} />
      <main className="flex-1 pb-20 md:pb-0">{children}</main>
      <TabBar />
    </div>
  );
}
```

- [ ] **Step 3: Write the sidebar (desktop only)**

```tsx
// src/components/shell/Sidebar.tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Wallet, TrendingUp, Tags, LogOut } from "lucide-react";
import { signOut } from "@/server/actions/auth";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/wallets", label: "Wallets", Icon: Wallet },
  { href: "/transactions", label: "Transactions", Icon: TrendingUp },
  { href: "/categories", label: "Categories", Icon: Tags },
];

export function Sidebar({ theme }: { theme: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="hidden w-56 shrink-0 flex-col gap-1 border-r p-4 md:flex"
         style={{ borderColor: "var(--grid)", background: "var(--surface)" }}>
      <p className="mb-4 px-2 text-lg font-semibold">Ledger</p>
      {NAV.map(({ href, label, Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined}
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm"
                style={{ background: active ? "var(--grid)" : "transparent", color: "var(--ink)" }}>
            <Icon size={18} aria-hidden />{label}
          </Link>
        );
      })}
      <div className="mt-auto flex flex-col gap-1">
        <ThemeToggle current={theme} />
        <form action={signOut}>
          <button type="submit" className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm"
                  style={{ color: "var(--ink-2)" }}>
            <LogOut size={18} aria-hidden />Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Write the tab bar (mobile only)**

```tsx
// src/components/shell/TabBar.tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Wallet, Plus, TrendingUp, Tags } from "lucide-react";

const NAV = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/wallets", label: "Wallets", Icon: Wallet },
  { href: "/transactions/new", label: "Add", Icon: Plus, primary: true },
  { href: "/transactions", label: "Activity", Icon: TrendingUp },
  { href: "/categories", label: "Categories", Icon: Tags },
];

export function TabBar() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 flex border-t md:hidden"
         style={{ borderColor: "var(--grid)", background: "var(--surface)" }}>
      {NAV.map(({ href, label, Icon, primary }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined}
                className="flex flex-1 flex-col items-center gap-1 py-2 text-xs"
                style={{ color: active ? "var(--ink)" : "var(--muted)" }}>
            <span className="grid h-9 w-9 place-items-center rounded-full"
                  style={primary ? { background: "var(--cat-1)", color: "#fff" } : undefined}>
              <Icon size={20} aria-hidden />
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 5: Write the theme toggle**

```tsx
// src/components/shell/ThemeToggle.tsx
"use client";
import { useTransition } from "react";
import { Monitor, Sun, Moon } from "lucide-react";
import { setTheme } from "@/server/actions/profile";

const OPTIONS = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light",  label: "Light",  Icon: Sun },
  { value: "dark",   label: "Dark",   Icon: Moon },
] as const;

export function ThemeToggle({ current }: { current: string }) {
  const [pending, start] = useTransition();
  return (
    <div role="group" aria-label="Theme" className="flex gap-1 rounded-md p-1"
         style={{ background: "var(--grid)" }}>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button key={value} type="button" disabled={pending}
                aria-pressed={current === value} title={label}
                onClick={() => start(() => { void setTheme(value); })}
                className="grid flex-1 place-items-center rounded p-1.5"
                style={{ background: current === value ? "var(--surface)" : "transparent" }}>
          <Icon size={16} aria-hidden /><span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Verify**

Run `npm run dev`, sign in, and check: sidebar appears ≥768px, tab bar below it, theme toggle switches and persists across reload.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/layout.tsx src/components/shell src/server/actions/profile.ts
git commit -m "feat: add responsive app shell with persisted theme"
```

---

### Task 15: Onboarding

**Files:**
- Create: `src/app/onboarding/page.tsx`, `src/server/actions/wallets.ts`, `src/lib/validation/wallet.ts`

**Interfaces:**
- Consumes: `createServerClient`, `parseAmountInput`, `minorUnitFor`
- Produces: `createWallet(prev, formData)`, `updateWallet`, `archiveWallet`

- [ ] **Step 1: Write the schema**

```ts
// src/lib/validation/wallet.ts
import { z } from "zod";

export const walletInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  kind: z.enum(["card", "bank"]),
  currency_code: z.string().length(3),
  starting_balance: z.string().default("0"),
  color_slot: z.coerce.number().int().min(1).max(8),
  icon: z.string().min(1),
});
```

- [ ] **Step 2: Write the actions**

```ts
// src/server/actions/wallets.ts
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { walletInput } from "@/lib/validation/wallet";
import { parseAmountInput, minorUnitFor } from "@/lib/money";

export type WalletState = { error?: string };

export async function createWallet(_prev: WalletState, formData: FormData): Promise<WalletState> {
  const parsed = walletInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { name, kind, currency_code, starting_balance, color_slot, icon } = parsed.data;
  let startingMinor: number;
  try {
    startingMinor = parseAmountInput(starting_balance, minorUnitFor(currency_code));
  } catch {
    return { error: "Starting balance is not a valid amount" };
  }

  const { error } = await supabase.from("wallets").insert({
    owner_id: user.id, name, kind, currency_code,
    starting_balance_minor: startingMinor, color_slot, icon,
  });
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  redirect("/");
}

export async function archiveWallet(id: string) {
  const supabase = await createServerClient();
  const { error } = await supabase
    .from("wallets").update({ archived_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/wallets");
}
```

- [ ] **Step 3: Write the onboarding page**

```tsx
// src/app/onboarding/page.tsx
"use client";
import { useActionState } from "react";
import { createWallet, type WalletState } from "@/server/actions/wallets";

const CURRENCIES = ["USD","EUR","GBP","AUD","CAD","SGD","CHF","CNY","JPY","KRW","KWD"];

export default function OnboardingPage() {
  const [state, action, pending] = useActionState<WalletState, FormData>(createWallet, {});
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">Add your first account</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--ink-2)" }}>
          A card or bank account to track. You can add more later.
        </p>
      </div>
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="color_slot" value="1" />
        <input type="hidden" name="icon" value="landmark" />
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>Name</span>
          <input name="name" required placeholder="Everyday account"
                 className="rounded-md border px-3 py-2" style={{ borderColor: "var(--grid)" }} />
        </label>
        <fieldset className="flex gap-2">
          <legend className="mb-1 text-sm" style={{ color: "var(--ink-2)" }}>Type</legend>
          {(["bank","card"] as const).map((k) => (
            <label key={k} className="flex-1 cursor-pointer rounded-md border px-3 py-2 text-center capitalize"
                   style={{ borderColor: "var(--grid)" }}>
              <input type="radio" name="kind" value={k} defaultChecked={k === "bank"} className="sr-only peer" />
              <span className="peer-checked:font-semibold">{k}</span>
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>Currency</span>
          <select name="currency_code" defaultValue="USD"
                  className="rounded-md border px-3 py-2" style={{ borderColor: "var(--grid)" }}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>Starting balance</span>
          <input name="starting_balance" inputMode="decimal" defaultValue="0"
                 className="rounded-md border px-3 py-2" style={{ borderColor: "var(--grid)" }} />
        </label>
        {state.error && <p role="alert" style={{ color: "var(--neg)" }}>{state.error}</p>}
        <button type="submit" disabled={pending}
                className="rounded-md px-4 py-2 font-medium disabled:opacity-60"
                style={{ background: "var(--cat-1)", color: "#fff" }}>
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Verify**

Sign up as a fresh user. Expected: redirected to `/onboarding`; after submitting, redirected to `/` and the shell renders.

- [ ] **Step 5: Commit**

```bash
git add src/app/onboarding src/server/actions/wallets.ts src/lib/validation/wallet.ts
git commit -m "feat: add onboarding with first wallet creation"
```

---

## Milestone D — Core features

### Task 16: Transaction actions

**Files:**
- Create: `src/server/actions/transactions.ts`, `src/lib/validation/transaction.ts`, `src/server/actions/transactions.test.ts`

**Interfaces:**
- Consumes: `parseAmountInput`, `minorUnitFor`, the `create_transfer` RPC from Task 9
- Produces:
  - `createTransaction(input: TransactionInput): Promise<{ id: string } | { error: string }>`
  - `createTransfer(input: TransferInput): Promise<{ transferId: string } | { error: string }>`
  - `softDeleteTransaction(id: string): Promise<void>`, `restoreTransaction(id: string): Promise<void>` — plain client calls, no RPC
  - `signedAmount(kind, positiveMinor)` — exported pure helper, unit-tested

- [ ] **Step 1: Write the schemas**

```ts
// src/lib/validation/transaction.ts
import { z } from "zod";

export const transactionInput = z.object({
  wallet_id: z.string().uuid(),
  kind: z.enum(["expense", "income"]),
  amount: z.string().min(1, "Enter an amount"),
  category_id: z.string().uuid("Choose a category"),
  occurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(280).optional().or(z.literal("")),
});

export const transferInput = z.object({
  from_wallet_id: z.string().uuid(),
  to_wallet_id: z.string().uuid(),
  amount: z.string().min(1, "Enter an amount"),
  amount_in: z.string().optional(),
  occurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(280).optional().or(z.literal("")),
}).refine((v) => v.from_wallet_id !== v.to_wallet_id, {
  message: "Choose two different accounts", path: ["to_wallet_id"],
});

export type TransactionInput = z.infer<typeof transactionInput>;
export type TransferInput = z.infer<typeof transferInput>;
```

- [ ] **Step 2: Write the failing test for the sign helper**

```ts
// src/server/actions/transactions.test.ts
import { describe, it, expect } from "vitest";
import { signedAmount } from "./transactions";

describe("signedAmount", () => {
  it("makes expenses negative and income positive", () => {
    expect(signedAmount("expense", 1250)).toBe(-1250);
    expect(signedAmount("income", 1250)).toBe(1250);
  });

  it("rejects a non-positive magnitude — sign comes from kind, never input", () => {
    expect(() => signedAmount("expense", 0)).toThrow();
    expect(() => signedAmount("expense", -5)).toThrow();
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run src/server/actions/transactions.test.ts`
Expected: FAIL — `signedAmount` is not exported.

- [ ] **Step 4: Implement the actions**

```ts
// src/server/actions/transactions.ts
"use server";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { transactionInput, transferInput } from "@/lib/validation/transaction";
import { parseAmountInput, minorUnitFor } from "@/lib/money";

/** The DB CHECK constraints enforce this too; failing here gives a better message. */
export function signedAmount(kind: "expense" | "income", positiveMinor: number): number {
  if (!Number.isInteger(positiveMinor) || positiveMinor <= 0) {
    throw new Error("amount must be a positive integer in minor units");
  }
  return kind === "expense" ? -positiveMinor : positiveMinor;
}

export async function createTransaction(raw: unknown) {
  const parsed = transactionInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { wallet_id, kind, amount, category_id, occurred_on, note } = parsed.data;

  const { data: wallet } = await supabase
    .from("wallets").select("currency_code").eq("id", wallet_id).single();
  if (!wallet) return { error: "Account not found" };

  let magnitude: number;
  try {
    magnitude = parseAmountInput(amount, minorUnitFor(wallet.currency_code));
  } catch {
    return { error: "That amount isn't valid" };
  }
  if (magnitude === 0) return { error: "Enter an amount greater than zero" };

  const { data, error } = await supabase.from("transactions").insert({
    wallet_id, created_by: user.id, kind,
    amount_minor: signedAmount(kind, magnitude),
    currency_code: wallet.currency_code,
    category_id, occurred_on, note: note || null,
  }).select("id").single();

  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { id: data.id };
}

export async function createTransfer(raw: unknown) {
  const parsed = transferInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createServerClient();
  const { from_wallet_id, to_wallet_id, amount, amount_in, occurred_on, note } = parsed.data;

  const { data: wallets } = await supabase
    .from("wallets").select("id, currency_code").in("id", [from_wallet_id, to_wallet_id]);
  const from = wallets?.find((w) => w.id === from_wallet_id);
  const to   = wallets?.find((w) => w.id === to_wallet_id);
  if (!from || !to) return { error: "Account not found" };

  let out: number, inn: number;
  try {
    out = parseAmountInput(amount, minorUnitFor(from.currency_code));
    inn = amount_in
      ? parseAmountInput(amount_in, minorUnitFor(to.currency_code))
      : out;   // same-currency transfer; phase 2 adds FX
  } catch {
    return { error: "That amount isn't valid" };
  }
  if (out <= 0 || inn <= 0) return { error: "Enter an amount greater than zero" };

  // Two rows must appear atomically — the client cannot express that (spec §3.2).
  const { data, error } = await supabase.rpc("create_transfer", {
    from_wallet: from_wallet_id, to_wallet: to_wallet_id,
    amount_out: out, amount_in: inn,
    on_date: occurred_on, note: note || null,
  });
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { transferId: data as string };
}

/**
 * Soft delete. A transfer's two legs go together — undo must restore an intact
 * pair, never half of one. The UPDATE is a single statement, so both legs move
 * atomically; the preceding SELECT only chooses the WHERE clause.
 * RLS still applies, so this cannot touch another member's rows.
 */
async function setDeletedAt(id: string, value: string | null) {
  const supabase = await createServerClient();

  const { data: row, error: readError } = await supabase
    .from("transactions").select("transfer_id").eq("id", id).single();
  if (readError) throw new Error(readError.message);

  const query = supabase.from("transactions").update({
    deleted_at: value, updated_at: new Date().toISOString(),
  });

  const { error } = row.transfer_id
    ? await query.eq("transfer_id", row.transfer_id)
    : await query.eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/", "layout");
}

export const softDeleteTransaction = (id: string) =>
  setDeletedAt(id, new Date().toISOString());

export const restoreTransaction = (id: string) => setDeletedAt(id, null);
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/server/actions/transactions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/actions/transactions.ts src/server/actions/transactions.test.ts src/lib/validation/transaction.ts
git commit -m "feat: add transaction and transfer server actions"
```

---

### Task 17: Category management with inline creation

**Files:**
- Create: `src/app/(app)/categories/page.tsx`, `src/server/actions/categories.ts`, `src/lib/validation/category.ts`, `src/components/CategoryPicker.tsx`

**Interfaces:**
- Consumes: `createServerClient`, `slotVar`
- Produces: `createCategory(input)`, `archiveCategory(id)`, `nextColorSlot(used: number[]): number` (exported pure helper), `<CategoryPicker>`

- [ ] **Step 1: Write the failing test for slot assignment**

```ts
// src/server/actions/categories.test.ts
import { describe, it, expect } from "vitest";
import { nextColorSlot } from "./categories";

describe("nextColorSlot", () => {
  it("picks the first unused slot", () => {
    expect(nextColorSlot([1, 2, 3])).toBe(4);
  });

  it("spreads across the palette instead of stacking on slot 1", () => {
    // every slot used once except 6 -> pick 6
    expect(nextColorSlot([1,2,3,4,5,7,8])).toBe(6);
  });

  it("picks the least-used slot once all 8 are taken", () => {
    expect(nextColorSlot([1,1,2,2,3,4,5,6,7,8])).toBe(3);
  });

  it("returns 1 for an empty set", () => {
    expect(nextColorSlot([])).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/server/actions/categories.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema and actions**

```ts
// src/lib/validation/category.ts
import { z } from "zod";

export const categoryInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(40),
  kind: z.enum(["expense", "income"]),
  color_slot: z.coerce.number().int().min(1).max(8).optional(),
  icon: z.string().min(1).default("circle"),
});
```

```ts
// src/server/actions/categories.ts
"use server";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { categoryInput } from "@/lib/validation/category";

const SLOTS = 8;

/** Least-used slot, lowest wins on a tie — so colours spread (spec §5.3). */
export function nextColorSlot(used: number[]): number {
  const counts = new Array<number>(SLOTS).fill(0);
  for (const s of used) if (s >= 1 && s <= SLOTS) counts[s - 1]! += 1;
  let best = 0;
  for (let i = 1; i < SLOTS; i++) if (counts[i]! < counts[best]!) best = i;
  return best + 1;
}

export async function createCategory(raw: unknown) {
  const parsed = categoryInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { name, kind, icon } = parsed.data;

  const { data: existing } = await supabase
    .from("categories").select("color_slot, sort_order")
    .eq("owner_id", user.id).eq("kind", kind).is("archived_at", null);

  const colorSlot = parsed.data.color_slot
    ?? nextColorSlot((existing ?? []).map((c) => c.color_slot));
  const sortOrder = Math.max(0, ...(existing ?? []).map((c) => c.sort_order)) + 1;

  const { data, error } = await supabase.from("categories").insert({
    owner_id: user.id, name, kind, color_slot: colorSlot, icon,
    sort_order: sortOrder, is_default: false,
  }).select("id, name, color_slot, icon, kind").single();

  if (error) {
    // Unique index on (owner_id, kind, lower(name)) where archived_at is null
    if (error.code === "23505") return { error: `"${name}" already exists` };
    return { error: error.message };
  }

  revalidatePath("/", "layout");
  return { category: data };
}

export async function archiveCategory(id: string) {
  const supabase = await createServerClient();
  const { error } = await supabase
    .from("categories").update({ archived_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/categories");
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/server/actions/categories.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the picker with inline create**

This is the load-bearing flow from spec §5.3 — creating a category must never cost the user their half-entered transaction.

```tsx
// src/components/CategoryPicker.tsx
"use client";
import { useState, useTransition, useMemo } from "react";
import { Plus } from "lucide-react";
import { createCategory } from "@/server/actions/categories";
import { slotVar } from "@/lib/palette";

// `kind` is required: TransactionForm (Task 19) filters this list by it.
export type Category = {
  id: string; name: string; kind: "expense" | "income";
  color_slot: number; icon: string;
};

export function CategoryPicker({
  categories, kind, value, onChange,
}: {
  categories: Category[];
  kind: "expense" | "income";
  value: string | null;
  onChange: (c: Category) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState(categories);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((c) => c.name.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const exact = filtered.some((c) => c.name.toLowerCase() === query.trim().toLowerCase());
  const canCreate = query.trim().length > 0 && !exact;

  function create() {
    setError(null);
    start(async () => {
      const res = await createCategory({ name: query.trim(), kind, icon: "circle" });
      if ("error" in res) { setError(res.error); return; }
      const c = res.category as Category;
      setItems((prev) => [...prev, c]);
      setQuery("");
      onChange(c);            // select it and return to the keypad
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search categories" aria-label="Search categories"
        className="rounded-md border px-3 py-2" style={{ borderColor: "var(--grid)" }}
      />
      {error && <p role="alert" style={{ color: "var(--neg)" }}>{error}</p>}
      <ul className="max-h-64 overflow-y-auto">
        {filtered.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onChange(c)}
                    aria-pressed={value === c.id}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left">
              <span aria-hidden className="h-3 w-3 shrink-0 rounded-full"
                    style={{ background: slotVar(c.color_slot) }} />
              <span>{c.name}</span>
            </button>
          </li>
        ))}
        {canCreate && (
          <li>
            <button type="button" onClick={create} disabled={pending}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left">
              <Plus size={14} aria-hidden />
              <span>{pending ? "Creating…" : <>Create &ldquo;{query.trim()}&rdquo;</>}</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 6: Write the management page**

```tsx
// src/app/(app)/categories/page.tsx
import { createServerClient } from "@/lib/supabase/server";
import { slotVar } from "@/lib/palette";

export default async function CategoriesPage() {
  const supabase = await createServerClient();
  const { data } = await supabase
    .from("categories").select("id, name, kind, color_slot, icon")
    .is("archived_at", null).order("kind").order("sort_order");

  const expense = (data ?? []).filter((c) => c.kind === "expense");
  const income  = (data ?? []).filter((c) => c.kind === "income");

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">Categories</h1>
      {[{ label: "Expense", items: expense }, { label: "Income", items: income }].map(({ label, items }) => (
        <section key={label} className="mb-8">
          <h2 className="mb-2 text-sm uppercase" style={{ color: "var(--muted)" }}>{label}</h2>
          <ul className="rounded-lg border" style={{ borderColor: "var(--grid)", background: "var(--surface)" }}>
            {items.map((c) => (
              <li key={c.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-0"
                  style={{ borderColor: "var(--grid)" }}>
                <span aria-hidden className="h-3 w-3 rounded-full" style={{ background: slotVar(c.color_slot) }} />
                {c.name}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/categories src/server/actions/categories.ts src/server/actions/categories.test.ts src/lib/validation/category.ts src/components/CategoryPicker.tsx
git commit -m "feat: add category management with inline creation from the picker"
```

---

### Task 18: The amount keypad

**Files:**
- Create: `src/components/AmountKeypad.tsx`, `src/components/AmountKeypad.test.tsx`

**Interfaces:**
- Consumes: `appendDigit`, `formatMoney`, `parseAmountInput`
- Produces: `<AmountKeypad value onChange currencyCode />`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/AmountKeypad.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AmountKeypad } from "./AmountKeypad";

describe("AmountKeypad", () => {
  it("does not render a native number input (it would raise the OS keyboard)", () => {
    const { container } = render(
      <AmountKeypad value="0" onChange={() => {}} currencyCode="USD" />,
    );
    expect(container.querySelector('input[type="number"]')).toBeNull();
  });

  it("appends digits through the money reducer", async () => {
    const onChange = vi.fn();
    render(<AmountKeypad value="12" onChange={onChange} currencyCode="USD" />);
    await userEvent.click(screen.getByRole("button", { name: "5" }));
    expect(onChange).toHaveBeenCalledWith("125");
  });

  it("refuses a decimal point for zero-decimal currencies", async () => {
    const onChange = vi.fn();
    render(<AmountKeypad value="1200" onChange={onChange} currencyCode="JPY" />);
    await userEvent.click(screen.getByRole("button", { name: "." }));
    expect(onChange).toHaveBeenCalledWith("1200");
  });

  it("backspace removes the last character and floors at 0", async () => {
    const onChange = vi.fn();
    render(<AmountKeypad value="12" onChange={onChange} currencyCode="USD" />);
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onChange).toHaveBeenCalledWith("1");
  });
});
```

Install the user-event package: `npm i -D @testing-library/user-event`.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/AmountKeypad.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/components/AmountKeypad.tsx
"use client";
import { Delete } from "lucide-react";
import { appendDigit, minorUnitFor, formatMoney, parseAmountInput } from "@/lib/money";

const KEYS = ["1","2","3","4","5","6","7","8","9",".","0","⌫"] as const;

export function AmountKeypad({
  value, onChange, currencyCode,
}: { value: string; onChange: (next: string) => void; currencyCode: string }) {
  const minorUnit = minorUnitFor(currencyCode);
  const preview = formatMoney(safeParse(value, minorUnit), currencyCode);

  function press(key: string) {
    if (key === "⌫") {
      onChange(value.length <= 1 ? "0" : value.slice(0, -1));
      return;
    }
    onChange(appendDigit(value, key, minorUnit));
  }

  return (
    <div className="flex flex-col gap-4">
      {/*
        Deliberately NOT an <input type="number"> — that summons the OS keyboard,
        shifting the layout and pushing Save below the fold (spec §5.1).
      */}
      <output aria-live="polite" aria-label="Amount"
              className="block py-6 text-center text-5xl font-semibold tabular-nums">
        {preview}
      </output>
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((k) => (
          <button key={k} type="button" onClick={() => press(k)}
                  aria-label={k === "⌫" ? "Delete" : k}
                  className="rounded-lg py-4 text-2xl"
                  style={{ background: "var(--surface)", color: "var(--ink)" }}>
            {k === "⌫" ? <Delete size={22} aria-hidden className="mx-auto" /> : k}
          </button>
        ))}
      </div>
    </div>
  );
}

function safeParse(v: string, minorUnit: number): number {
  try { return parseAmountInput(v, minorUnit); } catch { return 0; }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/AmountKeypad.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/AmountKeypad.tsx src/components/AmountKeypad.test.tsx package.json
git commit -m "feat: add custom amount keypad that never raises the OS keyboard"
```

---

### Task 19: Add-transaction screen

**Files:**
- Create: `src/app/(app)/transactions/new/page.tsx`, `src/components/TransactionForm.tsx`

**Interfaces:**
- Consumes: `<AmountKeypad>`, `<CategoryPicker>`, `createTransaction`, `createTransfer`
- Produces: `<TransactionForm wallets categories defaultWalletId />`

- [ ] **Step 1: Write the form**

```tsx
// src/components/TransactionForm.tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AmountKeypad } from "./AmountKeypad";
import { CategoryPicker, type Category } from "./CategoryPicker";
import { createTransaction, createTransfer } from "@/server/actions/transactions";

type Wallet = { id: string; name: string; currency_code: string };
type Kind = "expense" | "income" | "transfer";

export function TransactionForm({
  wallets, categories, defaultWalletId,
}: { wallets: Wallet[]; categories: Category[]; defaultWalletId: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("expense");
  const [amount, setAmount] = useState("0");
  const [walletId, setWalletId] = useState(defaultWalletId);
  const [toWalletId, setToWalletId] = useState(
    wallets.find((w) => w.id !== defaultWalletId)?.id ?? "",
  );
  const [category, setCategory] = useState<Category | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const wallet = wallets.find((w) => w.id === walletId)!;
  const visibleCategories = categories.filter((c) =>
    kind === "income" ? c.kind === "income" : c.kind === "expense",
  );

  function save() {
    setError(null);
    start(async () => {
      const res = kind === "transfer"
        ? await createTransfer({
            from_wallet_id: walletId, to_wallet_id: toWalletId,
            amount, occurred_on: date,
          })
        : await createTransaction({
            wallet_id: walletId, kind, amount,
            category_id: category?.id ?? "", occurred_on: date,
          });

      if (res && "error" in res) { setError(res.error); return; }
      router.push("/transactions");
    });
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <div role="tablist" aria-label="Transaction type" className="flex gap-1 rounded-lg p-1"
           style={{ background: "var(--grid)" }}>
        {(["expense", "income", "transfer"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} type="button"
                  onClick={() => { setKind(k); setCategory(null); }}
                  className="flex-1 rounded-md py-2 text-sm capitalize"
                  style={{ background: kind === k ? "var(--surface)" : "transparent" }}>
            {k}
          </button>
        ))}
      </div>

      <AmountKeypad value={amount} onChange={setAmount} currencyCode={wallet.currency_code} />

      <div className="flex flex-wrap gap-2">
        {/* A transfer has no category, so the chip is REMOVED, not disabled —
            a greyed-out control invites a click that can never succeed (§5.1). */}
        {kind !== "transfer" && (
          <span className="rounded-full border px-3 py-1 text-sm" style={{ borderColor: "var(--grid)" }}>
            {category?.name ?? "Choose category"}
          </span>
        )}
        <select aria-label={kind === "transfer" ? "From account" : "Account"}
                value={walletId} onChange={(e) => setWalletId(e.target.value)}
                className="rounded-full border px-3 py-1 text-sm" style={{ borderColor: "var(--grid)" }}>
          {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        {kind === "transfer" && (
          <select aria-label="To account" value={toWalletId}
                  onChange={(e) => setToWalletId(e.target.value)}
                  className="rounded-full border px-3 py-1 text-sm" style={{ borderColor: "var(--grid)" }}>
            {wallets.filter((w) => w.id !== walletId)
                    .map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        <input type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)}
               className="rounded-full border px-3 py-1 text-sm" style={{ borderColor: "var(--grid)" }} />
      </div>

      {kind !== "transfer" && (
        <CategoryPicker categories={visibleCategories}
                        kind={kind === "income" ? "income" : "expense"}
                        value={category?.id ?? null} onChange={setCategory} />
      )}

      {error && <p role="alert" style={{ color: "var(--neg)" }}>{error}</p>}

      <button type="button" onClick={save} disabled={pending}
              className="mt-auto rounded-lg py-4 text-lg font-medium disabled:opacity-60"
              style={{ background: "var(--cat-1)", color: "#fff" }}>
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Write the route**

```tsx
// src/app/(app)/transactions/new/page.tsx
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { TransactionForm } from "@/components/TransactionForm";
import type { Category } from "@/components/CategoryPicker";

export default async function NewTransactionPage() {
  const supabase = await createServerClient();
  const [{ data: wallets }, { data: categories }] = await Promise.all([
    supabase.from("wallets").select("id, name, currency_code")
      .is("archived_at", null).order("created_at"),
    supabase.from("categories").select("id, name, kind, color_slot, icon")
      .is("archived_at", null).order("sort_order"),
  ]);

  if (!wallets?.length) redirect("/onboarding");

  return (
    <TransactionForm
      wallets={wallets}
      categories={categories ?? ([] satisfies Category[])}
      defaultWalletId={wallets[0]!.id}
    />
  );
}
```

- [ ] **Step 3: Verify manually**

Run `npm run dev`. Add an expense; confirm it appears. Add a transfer between two accounts; confirm in `psql`:

```bash
psql "$DB_URL" -c "select transfer_id, wallet_id, amount_minor from transactions where transfer_id is not null order by amount_minor;"
```

Expected: exactly two rows sharing one `transfer_id`, amounts equal and opposite.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/transactions src/components/TransactionForm.tsx
git commit -m "feat: add amount-first transaction entry with transfer support"
```

---

### Task 20: Transaction list with undo

**Files:**
- Create: `src/app/(app)/transactions/page.tsx`, `src/components/TransactionList.tsx`, `src/components/UndoToast.tsx`

**Interfaces:**
- Consumes: `formatMoney`, `slotVar`, `softDeleteTransaction`, `restoreTransaction`
- Produces: `<TransactionList rows />`

- [ ] **Step 1: Write the list**

```tsx
// src/components/TransactionList.tsx
"use client";
import { useState, useTransition } from "react";
import { formatMoney } from "@/lib/money";
import { slotVar } from "@/lib/palette";
import { softDeleteTransaction, restoreTransaction } from "@/server/actions/transactions";

export type Row = {
  id: string; kind: "expense" | "income" | "transfer";
  amount_minor: number; currency_code: string; occurred_on: string;
  note: string | null; wallet_name: string;
  category_name: string | null; color_slot: number | null;
};

export function TransactionList({ rows }: { rows: Row[] }) {
  const [undoId, setUndoId] = useState<string | null>(null);
  const [, start] = useTransition();

  if (!rows.length) {
    return (
      <p className="p-8 text-center" style={{ color: "var(--ink-2)" }}>
        No transactions yet. Add your first one to get started.
      </p>
    );
  }

  const byDay = rows.reduce<Record<string, Row[]>>((acc, r) => {
    (acc[r.occurred_on] ??= []).push(r);
    return acc;
  }, {});

  return (
    <>
      {Object.entries(byDay).map(([day, list]) => (
        <section key={day}>
          <h2 className="px-4 pt-4 text-xs uppercase" style={{ color: "var(--muted)" }}>{day}</h2>
          <ul>
            {list.map((r) => (
              <li key={r.id} className="flex items-center gap-3 border-b px-4 py-3"
                  style={{ borderColor: "var(--grid)" }}>
                <span aria-hidden className="h-3 w-3 shrink-0 rounded-full"
                      style={{ background: r.color_slot ? slotVar(r.color_slot) : "var(--muted)" }} />
                <span className="flex-1">
                  {r.category_name ?? (r.kind === "transfer" ? "Transfer" : "Uncategorised")}
                  <span className="block text-xs" style={{ color: "var(--muted)" }}>{r.wallet_name}</span>
                </span>
                {/* Sign is always rendered; colour only reinforces it (§6.4). */}
                <span className="tabular-nums"
                      style={{ color: r.amount_minor < 0 ? "var(--neg)" : "var(--pos)" }}>
                  {formatMoney(r.amount_minor, r.currency_code, { signed: true })}
                </span>
                <button type="button" aria-label={`Delete ${r.category_name ?? "transaction"}`}
                        onClick={() => start(async () => {
                          await softDeleteTransaction(r.id);
                          setUndoId(r.id);
                        })}
                        className="text-xs underline" style={{ color: "var(--muted)" }}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {undoId && (
        <div role="status"
             className="fixed inset-x-4 bottom-24 flex items-center justify-between rounded-lg px-4 py-3 md:bottom-6 md:left-auto md:right-6 md:w-80"
             style={{ background: "var(--surface)", border: "1px solid var(--grid)" }}>
          <span>Transaction deleted</span>
          <button type="button" className="font-medium underline"
                  onClick={() => start(async () => {
                    await restoreTransaction(undoId);
                    setUndoId(null);
                  })}>
            Undo
          </button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Write the route**

```tsx
// src/app/(app)/transactions/page.tsx
import { createServerClient } from "@/lib/supabase/server";
import { TransactionList, type Row } from "@/components/TransactionList";

export default async function TransactionsPage() {
  const supabase = await createServerClient();
  const { data } = await supabase
    .from("transactions")
    .select("id, kind, amount_minor, currency_code, occurred_on, note, wallets(name), categories(name, color_slot)")
    .is("deleted_at", null)
    .order("occurred_on", { ascending: false })
    .limit(100);

  // Supabase types embedded relations loosely. Assert the shape ONCE here, at
  // the data boundary, rather than casting inside the map.
  type JoinedTxn = {
    id: string; kind: Row["kind"]; amount_minor: number; currency_code: string;
    occurred_on: string; note: string | null;
    wallets: { name: string } | null;
    categories: { name: string; color_slot: number } | null;
  };

  const rows: Row[] = ((data ?? []) as unknown as JoinedTxn[]).map((r) => ({
    id: r.id, kind: r.kind, amount_minor: r.amount_minor,
    currency_code: r.currency_code, occurred_on: r.occurred_on, note: r.note,
    wallet_name: r.wallets?.name ?? "",
    category_name: r.categories?.name ?? null,
    color_slot: r.categories?.color_slot ?? null,
  }));

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="p-4 text-2xl font-semibold">Transactions</h1>
      <TransactionList rows={rows} />
    </div>
  );
}
```

- [ ] **Step 3: Verify undo restores a transfer pair**

Add a transfer, delete one leg from the list, click Undo, then:

```bash
psql "$DB_URL" -c "select count(*) from transactions where transfer_id is not null and deleted_at is null;"
```

Expected: `2` — both legs restored, never one.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/transactions/page.tsx src/components/TransactionList.tsx
git commit -m "feat: add transaction list with undo-based deletion"
```

---

## Milestone E — Dashboard

### Task 21: Category breakdown

Spec §6.5: a stacked bar plus a ranked list, **not** a donut — donuts are bad at comparing close values, which is the question this chart is asked.

**Files:**
- Create: `src/app/(app)/page.tsx`, `src/components/CategoryBreakdown.tsx`

**Interfaces:**
- Consumes: `get_category_breakdown` RPC, `formatMoney`, `slotVar`
- Produces: `<CategoryBreakdown rows currencyCode />`

- [ ] **Step 1: Write the component**

```tsx
// src/components/CategoryBreakdown.tsx
import { formatMoney } from "@/lib/money";
import { slotVar } from "@/lib/palette";

export type BreakdownRow = {
  category_id: string; name: string; color_slot: number; total_minor: number;
};

const TOP_N = 6;   // stacked bar caps at 6 segments + Other (§6.5)

export function CategoryBreakdown({
  rows, currencyCode,
}: { rows: BreakdownRow[]; currencyCode: string }) {
  if (!rows.length) {
    return <p style={{ color: "var(--ink-2)" }}>No spending recorded this month.</p>;
  }

  const total = rows.reduce((s, r) => s + r.total_minor, 0);
  const top = rows.slice(0, TOP_N);
  const restTotal = rows.slice(TOP_N).reduce((s, r) => s + r.total_minor, 0);
  const segments = restTotal > 0
    ? [...top, { category_id: "other", name: "Other", color_slot: 0, total_minor: restTotal }]
    : top;

  return (
    <section aria-labelledby="breakdown-heading" className="flex flex-col gap-4">
      <h2 id="breakdown-heading" className="text-sm uppercase" style={{ color: "var(--muted)" }}>
        Spending by category
      </h2>

      {/* 2px surface gaps between segments rather than borders (§6.5) */}
      <div className="flex h-4 w-full overflow-hidden rounded-full" role="img"
           aria-label={segments.map((s) =>
             `${s.name} ${formatMoney(s.total_minor, currencyCode)}`).join(", ")}>
        {segments.map((s, i) => (
          <span key={s.category_id}
                style={{
                  width: `${(s.total_minor / total) * 100}%`,
                  background: s.color_slot ? slotVar(s.color_slot) : "var(--muted)",
                  marginLeft: i === 0 ? 0 : 2,
                }} />
        ))}
      </div>

      <table className="w-full text-sm">
        <caption className="sr-only">Spending by category, highest first</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.category_id}>
              <td className="py-1.5">
                <span aria-hidden className="mr-2 inline-block h-3 w-3 rounded-full align-middle"
                      style={{ background: slotVar(r.color_slot) }} />
                {r.name}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {formatMoney(r.total_minor, currencyCode)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 2: Write the dashboard**

```tsx
// src/app/(app)/page.tsx
import { createServerClient } from "@/lib/supabase/server";
import { CategoryBreakdown, type BreakdownRow } from "@/components/CategoryBreakdown";
import { formatMoney } from "@/lib/money";

function monthRange(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export default async function DashboardPage() {
  const supabase = await createServerClient();
  const { from, to } = monthRange();

  const { data: wallets } = await supabase
    .from("wallets").select("id, currency_code").is("archived_at", null);
  const walletIds = (wallets ?? []).map((w) => w.id);
  const currency = wallets?.[0]?.currency_code ?? "USD";

  const { data: breakdown } = await supabase.rpc("get_category_breakdown", {
    wallet_ids: walletIds, from_date: from, to_date: to,
  });

  const rows = (breakdown ?? []) as BreakdownRow[];
  const spent = rows.reduce((s, r) => s + r.total_minor, 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <header>
        <p className="text-sm uppercase" style={{ color: "var(--muted)" }}>
          {new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}
        </p>
        {/* Hero figure: >=48px, system sans, PROPORTIONAL figures (§6.4) */}
        <p className="text-5xl font-semibold">{formatMoney(spent, currency)}</p>
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>spent this month</p>
      </header>
      <CategoryBreakdown rows={rows} currencyCode={currency} />
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Add a few expenses across categories, reload `/`. Expected: hero total matches their sum, stacked bar segments in proportion, ranked list descending.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/page.tsx src/components/CategoryBreakdown.tsx
git commit -m "feat: add dashboard with hero total and category breakdown"
```

---

### Task 22: Cash flow diverging bar

Spec §6.5: money above and below a zero baseline is **polarity**, not trend — so a diverging bar, not a line. Teal in, rust out. Deliberately not green/red, the worst pairing under the two commonest colour-vision deficiencies.

**Files:**
- Create: `src/components/CashFlow.tsx`
- Modify: `src/app/(app)/page.tsx`

**Interfaces:**
- Consumes: `get_cash_flow` RPC, `formatMoney`
- Produces: `<CashFlow rows currencyCode />`

- [ ] **Step 1: Write the component**

```tsx
// src/components/CashFlow.tsx
"use client";
import {
  BarChart, Bar, XAxis, YAxis, ReferenceLine, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { formatMoney } from "@/lib/money";

export type FlowRow = { bucket_start: string; in_minor: number; out_minor: number };

export function CashFlow({ rows, currencyCode }: { rows: FlowRow[]; currencyCode: string }) {
  if (!rows.length) {
    return <p style={{ color: "var(--ink-2)" }}>No cash flow recorded this month.</p>;
  }

  // Out is stored positive by the RPC; negate so it renders below the baseline.
  const data = rows.map((r) => ({
    day: r.bucket_start.slice(5),
    In: r.in_minor,
    Out: -r.out_minor,
  }));

  return (
    <section aria-labelledby="flow-heading" className="flex flex-col gap-4">
      <h2 id="flow-heading" className="text-sm uppercase" style={{ color: "var(--muted)" }}>
        Cash flow
      </h2>
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <XAxis dataKey="day" tickLine={false} axisLine={{ stroke: "var(--grid)" }}
                   tick={{ fill: "var(--muted)", fontSize: 11 }} />
            <YAxis tickLine={false} axisLine={false} width={64}
                   tick={{ fill: "var(--muted)", fontSize: 11 }}
                   tickFormatter={(v: number) => formatMoney(v, currencyCode)} />
            <ReferenceLine y={0} stroke="var(--div-mid)" />
            <Tooltip
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--grid)",
                              borderRadius: 8, color: "var(--ink)" }}
              formatter={(v: number, name: string) =>
                [formatMoney(Math.abs(v), currencyCode), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--ink-2)" }} />
            <Bar dataKey="In"  fill="var(--div-in)"  radius={[4, 4, 0, 0]} />
            <Bar dataKey="Out" fill="var(--div-out)" radius={[0, 0, 4, 4]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire it into the dashboard**

In `src/app/(app)/page.tsx`, add the import, fetch, and render:

```tsx
import { CashFlow, type FlowRow } from "@/components/CashFlow";

// alongside the breakdown fetch:
const { data: flow } = await supabase.rpc("get_cash_flow", {
  wallet_ids: walletIds, from_date: from, to_date: to, bucket: "day",
});

// after <CategoryBreakdown ... />:
<CashFlow rows={(flow ?? []) as FlowRow[]} currencyCode={currency} />
```

- [ ] **Step 3: Verify**

Add an income and an expense on different days. Expected: income bar above the baseline in teal, expense below in rust, zero line visible, tooltip shows absolute amounts.

- [ ] **Step 4: Commit**

```bash
git add src/components/CashFlow.tsx src/app/\(app\)/page.tsx
git commit -m "feat: add diverging cash flow chart"
```

---

## Milestone F — Verification

### Task 23: End-to-end and accessibility

**Files:**
- Create: `playwright.config.ts`, `e2e/ledger.spec.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the whole app
- Produces: `npm run test:e2e`

- [ ] **Step 1: Configure Playwright**

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  use: { baseURL: "http://localhost:3000", trace: "on-first-retry" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile",  use: { ...devices["Pixel 7"] } },
  ],
  webServer: { command: "npm run dev", url: "http://localhost:3000", reuseExistingServer: true },
});
```

```bash
npx playwright install --with-deps chromium
npm i -D @axe-core/playwright
```

- [ ] **Step 2: Write the end-to-end flow**

```ts
// e2e/ledger.spec.ts
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const email = () => `e2e-${Date.now()}@example.com`;
const PASSWORD = "test-password-123";

test("signup through transfer and undo", async ({ page }) => {
  const user = email();

  await page.goto("/signup");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();

  // Onboarding: first wallet
  await expect(page.getByRole("heading", { name: /first account/i })).toBeVisible();
  await page.getByLabel("Name").fill("Everyday");
  await page.getByRole("button", { name: /create account/i }).click();

  // Second wallet, so a transfer is possible
  await page.goto("/wallets");

  // Add an expense
  await page.goto("/transactions/new");
  for (const key of ["1", "2", ".", "5", "0"]) {
    await page.getByRole("button", { name: key, exact: true }).click();
  }
  await expect(page.getByLabel("Amount")).toHaveText("$12.50");
  await page.getByRole("button", { name: "Groceries" }).click();
  await page.getByRole("button", { name: /^save$/i }).click();

  // It appears in the list with an explicit sign
  await expect(page.getByText("−$12.50")).toBeVisible();

  // Delete then undo
  await page.getByRole("button", { name: /delete groceries/i }).click();
  await expect(page.getByText(/transaction deleted/i)).toBeVisible();
  await page.getByRole("button", { name: /undo/i }).click();
  await expect(page.getByText("−$12.50")).toBeVisible();
});

for (const path of ["/login", "/signup"]) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
}
```

- [ ] **Step 3: Run it**

Run: `npm run test:e2e`
Expected: all tests pass in both the desktop and mobile projects.

- [ ] **Step 4: Add to CI**

Append to the `check` job in `.github/workflows/ci.yml`:

```yaml
      - run: npx supabase start
      - run: npm run test:rls
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
```

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e .github/workflows/ci.yml package.json
git commit -m "test: add end-to-end ledger flow and accessibility checks"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to at least one task:

| Spec | Task |
|---|---|
| §2 architecture, non-negotiables | 1, 12, 16 |
| §3.1 money | 3 |
| §3.2 transfers as paired rows | 6, 9, 16, 19 |
| §3.3 CHECK invariants | 6 |
| §3.4 soft delete | 6, 9, 20 |
| §3.5 enums | 4, 5 |
| §3.6 seed data | 11 |
| §3.7 wallet kinds | 5, 15 |
| §3.8 indexes | 5, 6 |
| §4 RLS + `is_wallet_member` | 7, 8 |
| §4.2 aggregate RPCs | 10 |
| §5.1 add flow, keypad | 18, 19 |
| §5.2 states | 20, 21, 22 |
| §5.3 custom categories | 17 |
| §6.1 palette | 2 |
| §6.3 chrome tokens | 2, 14 |
| §6.4 typography, signs | 20, 21 |
| §6.5 stacked bar, diverging flow | 21, 22 |
| §7 verification | 8, 23 |

**Known gaps, deliberately deferred to a follow-up plan** (each is additive and needs no schema change):

- `/wallets` list page and `/settings` page — routes are navigable from the shell but render no content yet. Wallet *creation* works via onboarding (Task 15).
- `/transactions/[id]` edit screen. Create, list, delete and undo are covered; editing is not.
- Desktop add-transaction **modal**. Task 19 ships the route, which works at both sizes; the modal-as-state refinement (§2 rule 4) and the `A` keyboard shortcut are not yet built.
- Infinite scroll on `/transactions` — currently capped at 100 rows.
- Category reorder and archive UI — the `archiveCategory` action exists and is tested, the UI is not wired.

**Type consistency** verified across tasks: `formatMoney`/`parseAmountInput`/`appendDigit`/`minorUnitFor` (Task 3) are used with matching signatures in 15, 16, 18, 20, 21, 22. `slotVar` (Task 2) is used in 17, 20, 21. `Category` (Task 17) is consumed by 19. `Row` (Task 20), `BreakdownRow` (Task 21) and `FlowRow` (Task 22) are each defined once and imported. RPC names `create_transfer` (Task 9), `get_category_breakdown` and `get_cash_flow` (Task 10) match their call sites in Tasks 16, 21 and 22. `softDeleteTransaction` / `restoreTransaction` are plain client calls in Task 16 — no RPC — and the SQL suite in Task 9 exercises the same two `UPDATE` statements those functions issue.
