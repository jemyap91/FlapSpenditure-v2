# Shared Household Wallets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a wallet owner invite another registered user into a wallet, so both people record transactions against one shared household ledger.

**Architecture:** Membership already backs every policy — `wallet_members` plus the `is_wallet_member()` `SECURITY DEFINER` predicate, in place since migrations `0002`/`0004`. Two things are added: categories move from being owned by a *user* to being owned by a *wallet* (so both members see the same list and neither sees the other's rows as "Uncategorised"), and a `wallet_invites` table with `SECURITY DEFINER` accept/decline functions, because the person accepting is by definition not yet a member and cannot insert their own membership row.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Supabase Postgres + Auth, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-20-shared-wallets-design.md`. Section references below (§1, §2, …) point into it.

## Global Constraints

- **Money is `bigint` signed minor units.** `parseFloat(x) * 100` is banned project-wide. Nothing in this plan touches money, but transactions are edited — do not introduce it.
- **Every SQL function is `set search_path = ''`** and schema-qualifies every name. `pg_temp` is searched before `search_path` for unqualified relations, so `search_path = public` alone is not a defence. This is established in `0002_wallets_categories.sql`.
- **Server Actions are reachable by direct POST.** Every action re-derives the caller via `supabase.auth.getUser()` and re-validates input with zod. `owner_id`/`user_id` are never accepted from the client.
- **Actions return error objects, never throw.** Next replaces thrown server errors with an opaque digest in production (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`), so a thrown message never reaches the user.
- **Raw Postgres/provider error strings are never forwarded to the client.**
- **`npm test` runs with no `.env.local`.** Any unit test whose import chain reaches `@/lib/supabase/*` must `vi.mock` it.
- **SQL suites are loopback-only.** `scripts/*.sh` refuse a non-loopback `DB_URL` because they issue destructive statements. Never point them at the hosted database.
- **Migrations are numbered and immutable once pushed.** This plan adds `0008` and `0009` only.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0008_wallet_scoped_categories.sql` | Re-scope categories to wallets, backfill, composite FK, move seeding to a wallet trigger |
| `supabase/migrations/0009_wallet_invites.sql` | `wallet_invites` table, its RLS, `accept_wallet_invite`, `decline_wallet_invite` |
| `supabase/tests/seed.sql` | Rewritten: seeding is per-wallet, not per-user |
| `supabase/tests/constraints.sql` | Extended: composite FK rejects a cross-wallet category |
| `supabase/tests/rls.sql` | Extended: invite visibility, accept/decline authorisation, member access |
| `src/lib/validation/invite.ts` | Zod schema for an invite email; `InviteField` |
| `src/server/actions/invites.ts` | `inviteToWallet`, `respondToInvite`, `removeMember` |
| `src/server/actions/categories.ts` | `createCategory` takes a `wallet_id` |
| `src/app/(app)/wallets/MembersSection.tsx` | Per-wallet member list + invite form (owner-only controls) |
| `src/app/(app)/wallets/PendingInvites.tsx` | Invites addressed to the signed-in user |
| `src/app/(app)/categories/page.tsx` | Wallet selector; categories read per wallet |
| `src/components/TransactionList.tsx` | "added by" attribution, multi-member wallets only |
| `e2e/sharing.spec.ts` | Two-browser-context sharing flow |

---

## Milestone A — Categories belong to the wallet

### Task 1: Migration `0008` — re-scope, backfill, constrain

**Files:**
- Create: `supabase/migrations/0008_wallet_scoped_categories.sql`

**Interfaces:**
- Consumes: `wallets`, `categories`, `transactions`, `is_wallet_member(uuid)` from `0002`/`0004`
- Produces: `categories.wallet_id` (NOT NULL), `categories_member` policy, `transactions_category_same_wallet` composite FK, `seed_wallet_categories()` trigger function

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0008_wallet_scoped_categories.sql
--
-- Categories move from belonging to a USER to belonging to a WALLET (spec §1).
--
-- Why: transactions_member lets a co-member read every transaction in a
-- shared wallet, but categories_own (owner_id = auth.uid()) hides the
-- category rows those transactions point at -- so a partner's rows render as
-- "Uncategorised" while get_category_breakdown, which is SECURITY DEFINER and
-- bypasses RLS, happily shows the same category's name on the dashboard.
-- Scoping categories to the wallet removes the split rather than papering
-- over it.

-- 1. Nullable first: the backfill below has to run before NOT NULL can hold.
alter table categories add column wallet_id uuid references wallets(id) on delete cascade;

-- 2. Copy each owner's categories into each wallet they own. `wallet_id is
--    null` identifies the pre-migration originals, so the copies this
--    statement creates are not themselves re-copied.
insert into categories (wallet_id, name, kind, color_slot, icon, sort_order, is_default, archived_at, created_at)
select w.id, c.name, c.kind, c.color_slot, c.icon, c.sort_order, c.is_default, c.archived_at, c.created_at
from wallets w
join categories c on c.owner_id = w.owner_id
where c.wallet_id is null;

-- 3. Repoint every transaction at the copy belonging to its OWN wallet,
--    matched on the same (kind, lower(btrim(name))) pair the uniqueness
--    index uses, so the match is exactly as unique as the schema guarantees.
--    Transfers have category_id null and are untouched.
update transactions t
set category_id = new_c.id
from categories old_c
join wallets w      on w.owner_id = old_c.owner_id
join categories new_c
  on new_c.wallet_id = w.id
 and new_c.kind = old_c.kind
 and lower(btrim(new_c.name)) = lower(btrim(old_c.name))
where t.category_id = old_c.id
  and t.wallet_id = w.id
  and old_c.wallet_id is null;

-- 4. Fail loudly rather than silently orphan a reference: if any transaction
--    still points at a pre-migration row, stop here.
do $$
declare stragglers integer;
begin
  select count(*) into stragglers
  from transactions t join categories c on c.id = t.category_id
  where c.wallet_id is null;
  if stragglers > 0 then
    raise exception 'backfill incomplete: % transaction(s) still reference a user-scoped category', stragglers;
  end if;
end $$;

delete from categories where wallet_id is null;
alter table categories alter column wallet_id set not null;

-- 5. Swap indexes and the policy from owner to wallet.
drop index categories_unique_active_name;
drop index categories_owner;

create unique index categories_unique_active_name
  on categories (wallet_id, kind, lower(btrim(name)))
  where archived_at is null;
create index categories_wallet on categories (wallet_id, kind) where archived_at is null;

drop policy categories_own on categories;
create policy categories_member on categories
  for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));

alter table categories drop column owner_id;

-- 6. A transaction may not reference another wallet's category. RLS cannot
--    express this and nothing enforced it before; wallet-scoping is what
--    makes the violation reachable, so the constraint ships with it.
--    MATCH SIMPLE (the default) skips the check when category_id is null,
--    which is exactly right for transfers.
alter table categories add constraint categories_id_wallet_unique unique (id, wallet_id);
alter table transactions
  add constraint transactions_category_same_wallet
  foreign key (category_id, wallet_id) references categories (id, wallet_id);

-- 7. Seeding moves from the user trigger to a wallet trigger, so every
--    wallet -- first or fifth -- starts with the 16 defaults (spec §1).
create function seed_wallet_categories() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categories (wallet_id, name, kind, color_slot, icon, sort_order, is_default) values
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
    (new.id,'Refunds',      'income', 7,'rotate-ccw',      4,true)
  on conflict do nothing;
  return new;
end $$;

create trigger wallets_seed_categories after insert on wallets
  for each row execute function seed_wallet_categories();
```

- [ ] **Step 2: Rewrite `handle_new_user` to stop seeding categories**

Append to the same migration file:

```sql
-- handle_new_user (0007) inserted the profile AND 16 categories. The category
-- half is now the wallets trigger's job; without this the function would
-- reference categories.owner_id, which no longer exists, and every signup
-- would fail.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
    values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;
```

- [ ] **Step 3: Apply and verify**

Run:
```bash
npx supabase db reset --no-seed
```
Expected: all migrations `0001`–`0008` apply with no error. If the DB container was just re-pulled this can fail once with `error running container: exit 1`; re-run it (see `DEPLOY.md`).

- [ ] **Step 4: Prove the new invariant rejects its bad case**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users (id, email) values ('cccccccc-0000-0000-0000-000000000003','carol@x.io');
insert into wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('11111111-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000003','A','bank','USD',0,1,'landmark'),
       ('22222222-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003','B','bank','USD',0,2,'landmark');
-- A category seeded into wallet A, used by a transaction in wallet B: must fail.
insert into transactions (wallet_id, kind, amount_minor, currency_code, category_id, occurred_on)
select '22222222-0000-0000-0000-000000000002','expense',-100,'USD', c.id, current_date
from categories c where c.wallet_id = '11111111-0000-0000-0000-000000000001' limit 1;
SQL
```
Expected: `ERROR: insert or update on table "transactions" violates foreign key constraint "transactions_category_same_wallet"`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0008_wallet_scoped_categories.sql
git commit -m "feat(db): scope categories to wallets and seed them per wallet"
```

---

### Task 2: Update the SQL suites for the new shape

**Files:**
- Modify: `supabase/tests/seed.sql`
- Modify: `supabase/tests/constraints.sql`

**Interfaces:**
- Consumes: Task 1's `seed_wallet_categories` trigger and `transactions_category_same_wallet` constraint
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Rewrite the seed assertions**

`supabase/tests/seed.sql` currently asserts a new `auth.users` row gets 16 categories. Replace that assertion block with:

```sql
-- Categories are seeded per WALLET now (0008), not per user: a brand-new
-- user has a profile and NO categories until they create their first wallet,
-- and every subsequent wallet gets its own 16.
insert into auth.users (id, email) values ('dddddddd-0000-0000-0000-000000000004','dave@x.io');

do $$ begin
  if (select count(*) from public.categories c
      join public.wallets w on w.id = c.wallet_id
      where w.owner_id = 'dddddddd-0000-0000-0000-000000000004') <> 0 then
    raise exception 'a user with no wallet should have no categories';
  end if;
  if (select count(*) from public.profiles where id = 'dddddddd-0000-0000-0000-000000000004') <> 1 then
    raise exception 'handle_new_user must still create the profile row';
  end if;
end $$;

insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('33333333-0000-0000-0000-000000000003','dddddddd-0000-0000-0000-000000000004','First','bank','USD',0,1,'landmark');

do $$ begin
  if (select count(*) from public.categories where wallet_id = '33333333-0000-0000-0000-000000000003') <> 16 then
    raise exception 'first wallet must be seeded with 16 categories';
  end if;
end $$;

insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('44444444-0000-0000-0000-000000000004','dddddddd-0000-0000-0000-000000000004','Second','bank','USD',0,2,'landmark');

do $$ begin
  if (select count(*) from public.categories where wallet_id = '44444444-0000-0000-0000-000000000004') <> 16 then
    raise exception 'every wallet gets its own 16, not just the first';
  end if;
end $$;

select 'seed tests passed';
```

- [ ] **Step 2: Add the composite-FK case to the constraints suite**

Append to `supabase/tests/constraints.sql`:

```sql
-- transactions_category_same_wallet (0008): a transaction may not point at a
-- category belonging to a different wallet. Transfers, whose category_id is
-- null, are exempt by MATCH SIMPLE and are asserted to still work.
insert into auth.users (id, email) values ('eeeeeeee-0000-0000-0000-000000000005','erin@x.io');
insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('55555555-0000-0000-0000-000000000005','eeeeeeee-0000-0000-0000-000000000005','X','bank','USD',0,1,'landmark'),
       ('66666666-0000-0000-0000-000000000006','eeeeeeee-0000-0000-0000-000000000005','Y','bank','USD',0,2,'landmark');

do $$
declare foreign_cat uuid;
begin
  select id into foreign_cat from public.categories
  where wallet_id = '55555555-0000-0000-0000-000000000005' limit 1;
  begin
    insert into public.transactions (wallet_id, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('66666666-0000-0000-0000-000000000006','expense',-100,'USD', foreign_cat, current_date);
    raise exception 'expected transactions_category_same_wallet to reject a cross-wallet category';
  exception when foreign_key_violation then
    null; -- correct
  end;
end $$;
```

- [ ] **Step 3: Run both suites**

Run:
```bash
npm run test:seed && npm run test:constraints
```
Expected: `seed tests passed` and `constraints tests passed`.

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/seed.sql supabase/tests/constraints.sql
git commit -m "test(db): assert per-wallet seeding and the cross-wallet category ban"
```

---

### Task 3: Make the app write wallet-scoped categories

**Files:**
- Modify: `src/lib/validation/category.ts`
- Modify: `src/server/actions/categories.ts`
- Test: `src/server/actions/categories.test.ts`

**Interfaces:**
- Consumes: Task 1's `categories.wallet_id`
- Produces: `categoryInput` gains `wallet_id: string`; `createCategory(raw: unknown): Promise<CategoryResult>` unchanged in signature but now requires `wallet_id` in `raw`

- [ ] **Step 1: Write the failing test**

Append to `src/server/actions/categories.test.ts`:

```ts
import { categoryInput } from "@/lib/validation/category";

describe("categoryInput — wallet scoping", () => {
  it("requires a wallet_id, since a category now belongs to a wallet", () => {
    const result = categoryInput.safeParse({ name: "Vet", kind: "expense", icon: "circle" });
    expect(result.success).toBe(false);
  });

  it("accepts a uuid wallet_id", () => {
    const result = categoryInput.safeParse({
      name: "Vet",
      kind: "expense",
      icon: "circle",
      wallet_id: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wallet_id that is not a uuid, rather than passing it to Postgres", () => {
    const result = categoryInput.safeParse({
      name: "Vet",
      kind: "expense",
      icon: "circle",
      wallet_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/actions/categories.test.ts`
Expected: FAIL — the first case passes parsing today because `wallet_id` is unknown to the schema.

- [ ] **Step 3: Add `wallet_id` to the schema**

In `src/lib/validation/category.ts`, inside `categoryInput`:

```ts
export const categoryInput = z.object({
  /** A category belongs to a wallet (0008), not to a user — so both members
   *  of a shared wallet see one list. Validated here rather than trusted,
   *  since a Server Action is reachable by direct POST. */
  wallet_id: z.uuid(),
  name: z.string().trim().min(1, "Name is required").max(40, "Name is too long"),
  kind: z.enum(Constants.public.Enums.category_kind),
  color_slot: z.coerce.number().int().min(1).max(8).optional(),
  icon: z.enum(CATEGORY_ICONS).default("circle"),
});
```

- [ ] **Step 4: Rewrite `createCategory`'s scoping**

In `src/server/actions/categories.ts`, replace the colour-slot query and the insert:

```ts
  const { wallet_id } = parsed.data;

  // Membership, not ownership: an invited member may create categories in a
  // shared wallet (spec §Decisions — equal on money). RLS enforces this too;
  // this check is so the action can return a readable message rather than a
  // policy violation.
  const { data: membership } = await supabase
    .from("wallet_members")
    .select("wallet_id")
    .eq("wallet_id", wallet_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return { error: "You do not have access to that account." };

  // Colour slots spread within the WALLET now, so two members of one wallet
  // never collide, and two wallets never constrain each other.
  const { data: existing } = await supabase
    .from("categories")
    .select("color_slot, sort_order")
    .eq("wallet_id", wallet_id)
    .is("archived_at", null);

  const colorSlot = parsed.data.color_slot ?? nextColorSlot((existing ?? []).map((c) => c.color_slot));

  const { data, error } = await supabase
    .from("categories")
    .insert({
      wallet_id,
      name: parsed.data.name,
      kind: parsed.data.kind,
      color_slot: colorSlot,
      icon: parsed.data.icon,
      sort_order: (existing?.length ?? 0) + 1,
    })
    .select("id, name, color_slot, icon, kind")
    .single();
```

Delete the `owner_id` references in this function; keep `archiveCategory` as-is (it scopes by `id`, and RLS now scopes by membership).

- [ ] **Step 5: Regenerate types and run the tests**

Run:
```bash
npm run db:types
npx vitest run src/server/actions/categories.test.ts
npm run typecheck
```
Expected: tests PASS; typecheck reports errors only in the UI files Task 4 fixes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/category.ts src/server/actions/categories.ts src/server/actions/categories.test.ts src/lib/database.types.ts
git commit -m "feat: create categories against a wallet rather than a user"
```

---

### Task 4: Give the category UI a wallet

**Files:**
- Modify: `src/app/(app)/categories/page.tsx`
- Modify: `src/app/(app)/categories/CategorySection.tsx`
- Modify: `src/components/CategoryPicker.tsx`
- Modify: `src/app/(app)/transactions/new/page.tsx`
- Modify: `src/components/TransactionForm.tsx`

**Interfaces:**
- Consumes: Task 3's `createCategory` requiring `wallet_id`
- Produces: `CategoryPicker` gains a required `walletId: string` prop; `/categories` accepts `?wallet=<uuid>`

- [ ] **Step 1: Add the wallet selector to `/categories`**

`/categories` no longer has "your" categories to show. Read the user's active wallets, pick the requested one (or the first), and query categories for it:

```tsx
export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string }>;
}) {
  const supabase = await createClient();
  const { wallet } = await searchParams;

  const { data: wallets, error: walletsError } = await supabase
    .from("wallets")
    .select("id, name")
    .is("archived_at", null)
    .order("created_at");
  if (walletsError) throw new Error("Failed to load wallets");
  if (!wallets?.length) redirect("/onboarding");

  // An unknown or absent ?wallet falls back to the first rather than
  // erroring: the id comes from a URL a user can edit, and RLS would return
  // an empty list for someone else's wallet anyway.
  const selected = wallets.find((w) => w.id === wallet) ?? wallets[0]!;

  const { data, error } = await supabase
    .from("categories")
    .select("id, name, kind, color_slot, icon")
    .eq("wallet_id", selected.id)
    .is("archived_at", null)
    .order("kind")
    .order("sort_order");
  if (error) throw new Error("Failed to load categories");

  const rows: Category[] = data ?? [];
  const expense = rows.filter((c) => c.kind === "expense");
  const income = rows.filter((c) => c.kind === "income");

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Categories
      </h1>
      {/* Plain links, not a <select>: this is a Server Component and the
          selection is a URL, so it needs no client JS and is shareable. */}
      <nav aria-label="Choose account" className="mb-6 flex flex-wrap gap-2">
        {wallets.map((w) => (
          <Link
            key={w.id}
            href={`/categories?wallet=${w.id}`}
            aria-current={w.id === selected.id ? "page" : undefined}
            className="rounded-full border px-3 py-1 text-sm"
            style={{
              borderColor: w.id === selected.id ? "var(--cat-1)" : "var(--ink-2)",
              fontWeight: w.id === selected.id ? 600 : 400,
              color: "var(--ink)",
            }}
          >
            {w.name}
          </Link>
        ))}
      </nav>
      <CategorySection kind="expense" label="Expense" initial={expense} walletId={selected.id} />
      <CategorySection kind="income" label="Income" initial={income} walletId={selected.id} />
    </div>
  );
}
```

Add `import Link from "next/link";` and `import { redirect } from "next/navigation";`.

- [ ] **Step 2: Thread `walletId` through the two client components**

In `CategorySection.tsx`, add `walletId: string` to the props type and pass it into every `createCategory` call:

```ts
const res = await createCategory({ name: trimmed, kind, icon: "circle", wallet_id: walletId });
```

In `CategoryPicker.tsx`, add `walletId: string` to the props type and do the same in its `create()` function.

- [ ] **Step 3: Pass the wallet from the add-transaction screen**

`TransactionForm` already tracks `walletId` in state. Pass it down:

```tsx
<CategoryPicker
  categories={categories}
  kind={kind}
  value={category?.id ?? null}
  onChange={handleCategoryChange}
  walletId={walletId}
/>
```

In `src/app/(app)/transactions/new/page.tsx`, scope the category query to the wallets the user can see, and let the form filter client-side per selected wallet:

```ts
    supabase
      .from("categories")
      .select("id, name, kind, color_slot, icon, wallet_id")
      .is("archived_at", null)
      .order("kind")
      .order("sort_order"),
```

Add `wallet_id: string` to the `Category` type in `CategoryPicker.tsx`, and in `TransactionForm` filter before rendering:

```ts
  // Categories belong to a wallet (0008), and the wallet chip can change
  // after mount — so filter on every render rather than snapshotting.
  const walletCategories = categories.filter((c) => c.wallet_id === walletId);
```

Pass `walletCategories` to `CategoryPicker`, and clear the selected category in `handleWalletChange` so a category from the previous wallet cannot be submitted — the composite FK would reject it, but the user should never get that far.

- [ ] **Step 4: Verify the whole flow**

Run:
```bash
npm run typecheck && npm test && npx playwright test
```
Expected: typecheck clean; all existing unit and e2e tests pass. The e2e "signup, onboard, add an expense" test exercises category selection, so a broken thread-through fails there.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/categories" src/components/CategoryPicker.tsx src/components/TransactionForm.tsx "src/app/(app)/transactions/new/page.tsx"
git commit -m "feat: choose categories per wallet across the category screens"
```

---

## Milestone B — Invitations

### Task 5: Migration `0009` — invites table, policies, accept/decline

**Files:**
- Create: `supabase/migrations/0009_wallet_invites.sql`

**Interfaces:**
- Consumes: `wallets`, `wallet_members`, `is_wallet_member(uuid)`
- Produces: `wallet_invites`; `accept_wallet_invite(uuid)`; `decline_wallet_invite(uuid)`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0009_wallet_invites.sql
--
-- In-app invitations (spec §2). No email is ever sent: Supabase's built-in
-- mailer is rate-limited (email_sent = 2/hour) and unfit for production, so
-- an invite is a row the invitee sees when they next open the app.

create type invite_status as enum ('pending', 'accepted', 'declined');

create table wallet_invites (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references wallets(id) on delete cascade,
  invited_email text not null check (length(btrim(invited_email)) between 3 and 320),
  invited_by    uuid not null references auth.users(id) on delete cascade,
  status        invite_status not null default 'pending',
  created_at    timestamptz not null default now(),
  responded_at  timestamptz
);

-- One OPEN invite per address per wallet. Scoped to pending so a declined
-- invite can be re-sent, mirroring how categories_unique_active_name frees a
-- name after archiving.
create unique index wallet_invites_one_pending
  on wallet_invites (wallet_id, lower(btrim(invited_email)))
  where status = 'pending';

create index wallet_invites_invitee
  on wallet_invites (lower(btrim(invited_email))) where status = 'pending';

alter table wallet_invites enable row level security;
grant select, insert, update, delete on wallet_invites to authenticated;

-- The wallet's OWNER manages its invites -- same shape as members_write.
create policy invites_owner on wallet_invites
  for all to authenticated
  using (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()));

-- The invitee may READ invites addressed to them, and nothing else. Status is
-- never client-writable: the functions below are the only way it changes, so
-- an invite cannot be marked accepted without the membership row appearing in
-- the same transaction.
create policy invites_invitee_select on wallet_invites
  for select to authenticated
  using (lower(btrim(invited_email)) = lower(btrim(auth.jwt() ->> 'email')));

-- SECURITY DEFINER is required, not merely convenient: members_write permits
-- an insert into wallet_members only by the wallet's owner, and the person
-- accepting is by definition not yet a member of anything.
create function accept_wallet_invite(invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  inv public.wallet_invites;
  caller_email text := lower(btrim(auth.jwt() ->> 'email'));
begin
  select * into inv from public.wallet_invites where id = invite for update;

  if inv is null or inv.status <> 'pending' then
    raise exception 'invite is not open';
  end if;
  if lower(btrim(inv.invited_email)) <> caller_email then
    raise exception 'invite is addressed to someone else';
  end if;

  insert into public.wallet_members (wallet_id, user_id, role)
  values (inv.wallet_id, auth.uid(), 'member')
  on conflict (wallet_id, user_id) do nothing;

  update public.wallet_invites
  set status = 'accepted', responded_at = now()
  where id = invite;
end $$;

create function decline_wallet_invite(invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  inv public.wallet_invites;
  caller_email text := lower(btrim(auth.jwt() ->> 'email'));
begin
  select * into inv from public.wallet_invites where id = invite for update;

  if inv is null or inv.status <> 'pending' then
    raise exception 'invite is not open';
  end if;
  if lower(btrim(inv.invited_email)) <> caller_email then
    raise exception 'invite is addressed to someone else';
  end if;

  update public.wallet_invites
  set status = 'declined', responded_at = now()
  where id = invite;
end $$;

revoke all on function accept_wallet_invite(uuid)  from public, anon;
revoke all on function decline_wallet_invite(uuid) from public, anon;
grant execute on function accept_wallet_invite(uuid)  to authenticated;
grant execute on function decline_wallet_invite(uuid) to authenticated;
```

- [ ] **Step 2: Apply**

Run: `npx supabase db reset --no-seed`
Expected: `0001`–`0009` apply cleanly.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0009_wallet_invites.sql
git commit -m "feat(db): add wallet invitations with definer accept/decline"
```

---

### Task 6: Adversarial RLS tests for invites

**Files:**
- Modify: `supabase/tests/rls.sql`

**Interfaces:**
- Consumes: Task 5's table and functions
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Append the invite blocks**

Follow the file's existing convention exactly: every impersonation inside `begin/commit`, with `set local role authenticated` and `set local request.jwt.claims`, and every denial paired with the matching permission. Note `auth.jwt()` reads the claims, so the email must be in them:

```sql
-- =====================================================================
-- Invitations (0009). Alice owns a wallet and invites Bob. Carol is the
-- outsider who must see and do nothing.
-- =====================================================================
insert into auth.users (id, email) values ('cccccccc-0000-0000-0000-000000000009','carol@x.io');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  insert into public.wallet_invites (id, wallet_id, invited_email, invited_by)
  select '77777777-0000-0000-0000-000000000007', w.id, 'bob@x.io', 'aaaaaaaa-0000-0000-0000-000000000001'
  from public.wallets w where w.owner_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1;
commit;

-- Carol cannot see an invite addressed to Bob.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    if (select count(*) from public.wallet_invites) <> 0 then
      raise exception 'an outsider can see an invite addressed to someone else';
    end if;
  end $$;
commit;

-- Carol cannot accept an invite addressed to Bob.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    begin
      perform public.accept_wallet_invite('77777777-0000-0000-0000-000000000007');
      raise exception 'accept_wallet_invite let the wrong person in';
    exception when others then
      null; -- correct
    end;
  end $$;
commit;

-- Bob sees his own invite, accepts it, and gains access to Alice's ledger.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    if (select count(*) from public.wallet_invites) <> 1 then
      raise exception 'the invitee cannot see their own invite';
    end if;
  end $$;
  select public.accept_wallet_invite('77777777-0000-0000-0000-000000000007');
  do $$ begin
    if (select status from public.wallet_invites where id = '77777777-0000-0000-0000-000000000007') <> 'accepted' then
      raise exception 'accepting did not mark the invite accepted';
    end if;
    if (select count(*) from public.transactions) = 0 then
      raise exception 'an accepted member cannot read the wallet''s transactions';
    end if;
    if (select count(*) from public.categories) = 0 then
      raise exception 'an accepted member cannot read the wallet''s categories -- the Uncategorised bug';
    end if;
  end $$;
commit;

-- Carol still sees nothing after Bob has joined.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    if (select count(*) from public.transactions) <> 0 then
      raise exception 'a non-member can read a shared wallet''s transactions';
    end if;
  end $$;
commit;
```

- [ ] **Step 2: Prove the test catches a leak**

Temporarily weaken `invites_invitee_select` to `using (true)` in `0009`, run `npm run test:rls`, and confirm the "outsider can see an invite" assertion fires. Restore the policy afterwards.

- [ ] **Step 3: Run clean**

Run: `npm run test:rls`
Expected: `RLS tests passed`.

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/rls.sql
git commit -m "test(db): prove invite visibility and accept authorisation"
```

---

### Task 7: Invite server actions

**Files:**
- Create: `src/lib/validation/invite.ts`
- Create: `src/server/actions/invites.ts`
- Test: `src/lib/validation/invite.test.ts`

**Interfaces:**
- Consumes: Task 5's table and functions
- Produces: `inviteToWallet(walletId: string, prev: InviteState, formData: FormData): Promise<InviteState>`; `respondToInvite(id: string, accept: boolean): Promise<InviteState>`; `removeMember(walletId: string, userId: string): Promise<InviteState>`; `type InviteState = { error?: string; notice?: string }`

- [ ] **Step 1: Write the failing schema test**

```ts
// src/lib/validation/invite.test.ts
import { describe, it, expect } from "vitest";
import { inviteInput } from "@/lib/validation/invite";

describe("inviteInput", () => {
  it("accepts a plain address", () => {
    expect(inviteInput.safeParse({ email: "sam@example.com" }).success).toBe(true);
  });

  it("lower-cases and trims, so matching the invitee is case-insensitive", () => {
    const parsed = inviteInput.parse({ email: "  Sam@Example.COM " });
    expect(parsed.email).toBe("sam@example.com");
  });

  it("rejects a non-address rather than storing it", () => {
    expect(inviteInput.safeParse({ email: "sam" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/validation/invite.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/validation/invite"`.

- [ ] **Step 3: Write the schema**

```ts
// src/lib/validation/invite.ts
import { z } from "zod";

/**
 * An invite is a claim about an email ADDRESS, not a user id — the person may
 * not have signed up when it is created. Stored lower-cased and trimmed
 * because `accept_wallet_invite` matches it against the caller's JWT email
 * the same way.
 */
export const inviteInput = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address")),
});

export type InviteInput = z.infer<typeof inviteInput>;
export type InviteField = keyof InviteInput;
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/validation/invite.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the actions**

```ts
// src/server/actions/invites.ts
"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { inviteInput } from "@/lib/validation/invite";

export type InviteState = { error?: string; notice?: string };

/**
 * Server Functions are reachable by direct POST, so each action below
 * re-derives the caller and re-checks authority rather than trusting the UI
 * that rendered the control. Errors are RETURNED, never thrown: Next replaces
 * thrown server errors with an opaque digest in production.
 */

export async function inviteToWallet(
  walletId: string,
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const parsed = inviteInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  if (parsed.data.email === (user.email ?? "").toLowerCase()) {
    return { error: "You are already in this account." };
  }

  const { error } = await supabase.from("wallet_invites").insert({
    wallet_id: walletId,
    invited_email: parsed.data.email,
    invited_by: user.id,
  });
  // invites_owner rejects a non-owner, and wallet_invites_one_pending rejects
  // a duplicate. Neither raw message is forwarded — see the module comment.
  if (error) return { error: "Could not send that invitation. Please try again." };

  revalidatePath("/wallets");
  // Deliberately identical whether or not that address has an account: this
  // form must not become a way to test who is registered, the same reasoning
  // src/lib/validation/auth.ts applies to signup.
  return { notice: `Invitation sent to ${parsed.data.email}.` };
}

export async function respondToInvite(id: string, accept: boolean): Promise<InviteState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase.rpc(
    accept ? "accept_wallet_invite" : "decline_wallet_invite",
    { invite: id },
  );
  if (error) return { error: "Could not respond to that invitation." };

  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  return {};
}

export async function removeMember(walletId: string, userId: string): Promise<InviteState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  // The owner's own membership row is what makes them a member; removing it
  // would lock them out of a wallet they still own.
  const { data: wallet } = await supabase
    .from("wallets").select("owner_id").eq("id", walletId).maybeSingle();
  if (!wallet || wallet.owner_id !== user.id) return { error: "Only the account owner can do that." };
  if (userId === wallet.owner_id) return { error: "The owner cannot be removed." };

  const { error } = await supabase
    .from("wallet_members").delete().eq("wallet_id", walletId).eq("user_id", userId);
  if (error) return { error: "Could not remove that person. Please try again." };

  revalidatePath("/wallets");
  return {};
}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/validation/invite.ts src/lib/validation/invite.test.ts src/server/actions/invites.ts
git commit -m "feat: add invite, respond and remove-member actions"
```

---

### Task 8: Members and pending invites on `/wallets`

**Files:**
- Create: `src/app/(app)/wallets/MembersSection.tsx`
- Create: `src/app/(app)/wallets/PendingInvites.tsx`
- Modify: `src/app/(app)/wallets/page.tsx`
- Test: `src/app/(app)/wallets/MembersSection.test.tsx`

**Interfaces:**
- Consumes: Task 7's actions
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the failing component test**

```tsx
// src/app/(app)/wallets/MembersSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MembersSection, type Member } from "./MembersSection";
import { removeMember } from "@/server/actions/invites";

vi.mock("@/server/actions/invites", () => ({
  removeMember: vi.fn(),
  inviteToWallet: vi.fn(),
}));

const members: Member[] = [
  { user_id: "u1", display_name: "Alex", role: "owner" },
  { user_id: "u2", display_name: "Sam", role: "member" },
];

beforeEach(() => {
  vi.mocked(removeMember).mockReset();
  vi.mocked(removeMember).mockResolvedValue({});
});

describe("MembersSection", () => {
  it("marks who owns the account", () => {
    render(<MembersSection walletId="w1" members={members} isOwner />);
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("offers Remove to the owner, but never for the owner's own row", () => {
    render(<MembersSection walletId="w1" members={members} isOwner />);
    expect(screen.getByRole("button", { name: "Remove Sam" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Alex" })).not.toBeInTheDocument();
  });

  it("hides Remove entirely from a non-owner", () => {
    render(<MembersSection walletId="w1" members={members} isOwner={false} />);
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it("removes the person whose button was pressed", async () => {
    const user = userEvent.setup();
    render(<MembersSection walletId="w1" members={members} isOwner />);
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    expect(removeMember).toHaveBeenCalledExactlyOnceWith("w1", "u2");
  });

  it("surfaces a failure rather than appearing to succeed", async () => {
    vi.mocked(removeMember).mockResolvedValue({ error: "Only the account owner can do that." });
    const user = userEvent.setup();
    render(<MembersSection walletId="w1" members={members} isOwner />);
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the account owner can do that.");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run "src/app/(app)/wallets/MembersSection.test.tsx"`
Expected: FAIL — `Failed to resolve import "./MembersSection"`.

- [ ] **Step 3: Implement `MembersSection`**

A Client Component: the member list is passed in from the page, and Remove plus the invite form are interactive. Model it on `WalletList.tsx` — an always-mounted `role="alert"` paragraph, `useTransition`, per-row pending state, and `aria-label` on each Remove naming the person. The invite form uses `useActionState(inviteToWallet.bind(null, walletId), {})` and renders `state.notice` as well as `state.error`.

```tsx
export type Member = { user_id: string; display_name: string; role: "owner" | "member" };
```

- [ ] **Step 4: Implement `PendingInvites`**

A Client Component listing invites addressed to the signed-in user, each with Accept and Decline calling `respondToInvite(id, true|false)`. Renders nothing when the list is empty, so it costs no space in the common case.

- [ ] **Step 5: Wire both into the page**

In `src/app/(app)/wallets/page.tsx`, add two queries alongside the existing ones — `wallet_members` joined to `profiles` for display names, and `wallet_invites` where `status = 'pending'` (RLS already limits this to invites addressed to the caller). Render `<PendingInvites …/>` above the wallet list, and a `<MembersSection …/>` per wallet. Compute `isOwner` by comparing the wallet's `owner_id` to the current user's id.

- [ ] **Step 6: Run everything**

Run: `npm run typecheck && npm test && npx playwright test`
Expected: all pass, including the axe checks — `/wallets` is in the signed-in accessibility sweep, so a contrast or labelling regression fails there.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/wallets"
git commit -m "feat: manage members and respond to invitations on /wallets"
```

---

### Task 9: Attribution on shared transactions

**Files:**
- Modify: `src/components/TransactionList.tsx`
- Modify: `src/app/(app)/transactions/page.tsx`
- Test: `src/components/TransactionList.test.tsx`

**Interfaces:**
- Consumes: `transactions.created_by`, already populated by `createTransaction` and `create_transfer`
- Produces: `Row` gains `created_by_name: string | null`; `TransactionList` gains `showAttribution: boolean`

- [ ] **Step 1: Write the failing test**

```tsx
describe("TransactionList — attribution", () => {
  it("says who added a row when the wallet has more than one member", () => {
    render(
      <TransactionList
        rows={[{ ...baseRow, created_by_name: "Sam", note: "Starbucks", category_name: "Coffee" }]}
        showAttribution
      />,
    );
    expect(screen.getByText(/added by Sam/i)).toBeInTheDocument();
  });

  it("stays silent in a single-member wallet, where every row would say 'you'", () => {
    render(
      <TransactionList
        rows={[{ ...baseRow, created_by_name: "Sam", note: "Starbucks", category_name: "Coffee" }]}
        showAttribution={false}
      />,
    );
    expect(screen.queryByText(/added by/i)).not.toBeInTheDocument();
  });

  it("omits attribution for a row whose author is unknown", () => {
    // created_by is ON DELETE SET NULL, so a removed account leaves rows with
    // no author rather than deleting the ledger history.
    render(
      <TransactionList rows={[{ ...baseRow, created_by_name: null }]} showAttribution />,
    );
    expect(screen.queryByText(/added by/i)).not.toBeInTheDocument();
  });
});
```

Add `created_by_name: null` to the existing `baseRow` fixture so the other tests keep compiling.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/components/TransactionList.test.tsx`
Expected: FAIL — `showAttribution` is not a prop and `created_by_name` is not on `Row`.

- [ ] **Step 3: Implement**

Add `created_by_name: string | null` to `Row` and `showAttribution?: boolean` (default `false`) to the props. Append the author to the existing secondary line rather than adding a third:

```tsx
{[
  noteOf(r) && r.category_name ? r.category_name : null,
  r.wallet_name,
  showAttribution && r.created_by_name ? `added by ${r.created_by_name}` : null,
].filter(Boolean).join(" · ")}
```

- [ ] **Step 4: Supply the data**

In `src/app/(app)/transactions/page.tsx`, select the author and count members:

```ts
      "id, kind, amount_minor, currency_code, occurred_on, note, created_by, wallets(name), categories(name, color_slot, icon), profiles:created_by(display_name)",
```

Map `created_by_name: r.profiles?.display_name ?? null`, and compute `showAttribution` from whether any readable wallet has more than one member:

```ts
  const { data: memberCounts } = await supabase.from("wallet_members").select("wallet_id, user_id");
  const shared = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of memberCounts ?? []) {
    const n = (seen.get(m.wallet_id) ?? 0) + 1;
    seen.set(m.wallet_id, n);
    if (n > 1) shared.add(m.wallet_id);
  }
  const showAttribution = rows.some((r) => shared.has(r.wallet_id));
```

Add `wallet_id` to the select and to `Row` for this comparison.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/components/TransactionList.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/TransactionList.tsx src/components/TransactionList.test.tsx "src/app/(app)/transactions/page.tsx"
git commit -m "feat: show who added a transaction in shared wallets"
```

---

### Task 10: End-to-end sharing flow

**Files:**
- Create: `e2e/sharing.spec.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `npm run test:e2e` covers the two-person flow

- [ ] **Step 1: Write the test**

```ts
// e2e/sharing.spec.ts
import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const PASSWORD = "test-password-123";
let n = 0;
const email = () => `share-${Date.now()}-${n++}@example.com`;

async function signUpAndOnboard(page: Page, wallet: string): Promise<string> {
  const user = email();
  await page.goto("/signup");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Add your first account" })).toBeVisible();
  await page.getByLabel("Name").fill(wallet);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  return user;
}

async function addExpense(page: Page, amount: string, category: string, note: string) {
  await page.goto("/transactions/new");
  for (const k of amount) await page.getByRole("button", { name: k, exact: true }).click();
  await page.getByRole("button", { name: category }).click();
  await page.getByLabel("Note").fill(note);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL("/transactions");
}

test("a household shares one ledger", async ({ browser }) => {
  // Two contexts, not two pages: each needs its own cookie jar, or the second
  // signup would replace the first person's session.
  const ctxA: BrowserContext = await browser.newContext();
  const ctxB: BrowserContext = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await signUpAndOnboard(a, "Household");
  await addExpense(a, "30", "Groceries", "Market");

  const bEmail = await signUpAndOnboard(b, "Bs own wallet");

  await a.goto("/wallets");
  await a.getByLabel("Invite by email").fill(bEmail);
  await a.getByRole("button", { name: "Send invitation" }).click();
  await expect(a.getByText(new RegExp(`Invitation sent to ${bEmail}`, "i"))).toBeVisible();

  await b.goto("/wallets");
  await expect(b.getByText("Household")).toBeVisible();
  await b.getByRole("button", { name: "Accept" }).click();

  // The bug this whole design exists to fix: B must see A's category NAME,
  // not "Uncategorised".
  await b.goto("/transactions");
  await expect(b.getByText("Market")).toBeVisible();
  await expect(b.getByText(/Groceries/)).toBeVisible();
  await expect(b.getByText("Uncategorised")).toHaveCount(0);

  // B contributes to the shared ledger and A sees it, attributed.
  await addExpense(b, "12", "Transport", "Bus pass");
  await a.goto("/transactions");
  await expect(a.getByText("Bus pass")).toBeVisible();
  await expect(a.getByText(/added by/i).first()).toBeVisible();

  // Removing B revokes access immediately.
  await a.goto("/wallets");
  await a.getByRole("button", { name: /^Remove/ }).click();
  await b.goto("/transactions");
  await expect(b.getByText("Market")).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/sharing.spec.ts`
Expected: PASS in both the desktop and mobile projects.

- [ ] **Step 3: Run the whole suite**

Run:
```bash
npm run validate:palette && npm run typecheck && npm run lint && npm test
npm run test:rls && npm run test:constraints && npm run test:seed
npx playwright test
```
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add e2e/sharing.spec.ts
git commit -m "test(e2e): cover the two-person shared household flow"
```

---

## Milestone C — Production rollout

### Task 11: Migrate the hosted database safely

**Files:**
- Modify: `DEPLOY.md`

**Interfaces:**
- Consumes: migrations `0008` and `0009`
- Produces: a migrated production database

- [ ] **Step 1: Back up first**

The backfill rewrites `transactions.category_id` on live rows and is not idempotent. Take a backup from the Supabase dashboard (Database → Backups) and confirm it exists before continuing. **Do not skip this.**

- [ ] **Step 2: Rehearse against a copy**

Restore that backup into a scratch project (or a local database loaded from it) and run `npx supabase db push` against the copy. Confirm: no `backfill incomplete` exception; every transaction's category shares its wallet; and category counts equal 16 × wallets, plus any custom ones.

Run against the copy:
```sql
select count(*) from transactions t
join categories c on c.id = t.category_id
where c.wallet_id <> t.wallet_id;   -- expect 0
```

- [ ] **Step 3: Push to production**

Run: `npx supabase db push`
Expected: `0008` and `0009` listed as pending, then applied.

- [ ] **Step 4: Verify the deployed app**

Sign in, confirm categories still resolve on `/transactions`, add a transaction, and check `/categories` shows the wallet selector.

- [ ] **Step 5: Document it**

Add a short section to `DEPLOY.md` noting that `0008` performs a data backfill, that a backup must be taken first, and that `transactions_category_same_wallet` failing means the backfill was incomplete rather than the schema being wrong.

- [ ] **Step 6: Commit**

```bash
git add DEPLOY.md
git commit -m "docs: note the 0008 backfill and its backup requirement"
```

---

## Self-Review

**Spec coverage.**

| Spec section | Task |
|---|---|
| §Decisions — in-app invites | 5, 7, 8 |
| §Decisions — equal on money, owner manages people | 5 (policies), 7 (`removeMember` owner check) |
| §1 categories wallet-scoped, indexes, policy | 1 |
| §1 composite FK | 1, 2 |
| §1 backfill | 1, 11 |
| §1 seeding moves | 1, 2 |
| §1 `/categories` wallet selector | 4 |
| §2 `wallet_invites`, RLS, accept/decline | 5 |
| §3 three server actions, enumeration-safety | 7 |
| §4 members UI, pending invites | 8 |
| §4 attribution, multi-member only | 9 |
| §5 what does not change | — (verified by existing suites in 4, 8) |
| §6 testing | 2, 6, 9, 10 |
| §7 risks — backup, rehearsal | 11 |

**Type consistency.** `Member` is defined in Task 8 and used only there. `InviteState` is defined in Task 7 and consumed in Task 8. `Row` gains `note` (already shipped), `created_by_name` and `wallet_id` in Task 9. `Category` gains `wallet_id` in Task 4, consumed by `CategoryPicker` and `TransactionForm` in the same task. `categoryInput` gains `wallet_id` in Task 3 and every caller is updated in Task 4.

**Known gaps, deliberately out of scope** (each additive, none blocking): email-delivered invites, leaving a wallet you were invited to, transferring ownership, roles beyond owner/member, and per-member spending limits.
