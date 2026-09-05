# Space-Scoped Categories — Design

**Date:** 2026-09-05
**Status:** Implemented on `feat/space-scoped-categories` (2026-09-05); see §12 for where the implementation departs from this document
**Supersedes the category-scoping decision in:** `0008_wallet_scoped_categories.sql`

## 1. Problem

Categories belong to a wallet. With nine wallets that means nine independent
category lists and roughly 144 rows, which produces three user-visible faults:

1. The `/categories` screen must open with a wallet chip row, because "the
   category list" does not exist — only "this wallet's category list" does.
2. A category created while one wallet is selected is invisible when editing a
   transaction in any other wallet. `transactions/[id]/edit/page.tsx` filters
   with `.in("wallet_id", candidates)`, and the composite FK
   `transactions_category_same_wallet` makes the cross-wallet reference
   impossible at the database level regardless of what the UI offers.
3. Edits do not propagate. Renaming `Transport` to `Public Transport`, or
   changing an icon or colour, changes one of nine copies.

A fourth fault is internal. `0013_wallet_set_budgets.sql` needed a budget to
span several wallets, and since each wallet has its own row for "Groceries"
there was no id to reference. It fell back to matching on a normalised name
string (`budgets.category_key`), guarded by a CHECK forcing
`lower(btrim(...))`. That is a foreign key downgraded to a string join, and it
exists only because of wallet scoping.

### Why the obvious fix is wrong

Reverting to user-scoped categories — the pre-`0008` model — reintroduces the
bug `0008` was written to fix. Quoting its header:

> `transactions_member` lets a co-member read every transaction in a shared
> wallet, but `categories_own (owner_id = auth.uid())` hides the category rows
> those transactions point at — so a partner's rows render as "Uncategorised"
> while `get_category_breakdown`, which is SECURITY DEFINER and bypasses RLS,
> happily shows the same category's name on the dashboard.

The invariant that actually matters is:

> **Everyone who can read a transaction must be able to read its category.**

Wallet scoping satisfies this by construction and costs the three faults above.
User scoping violates it. The scope that satisfies it *without* fragmenting the
list is the household.

## 2. Decisions

| Decision | Choice |
|---|---|
| Category scope | A new **space** (household). One space per connected component of the wallet-sharing graph; for the current data, one space holding all nine wallets. |
| Merge rule | **Keep every distinct name.** Dedupe on `(kind, lower(btrim(name)))`. `Transport` and `Public Transport` both survive as separate categories. |
| Budgets | Convert `category_key` back to a real `category_id` foreign key in the same change. |
| Space membership | Structural, not advisory — a composite FK makes it impossible to be a wallet member without being a member of that wallet's space. |

## 3. Model

```
spaces (id, name, created_at)
space_members (space_id, user_id, role, joined_at)   PK (space_id, user_id)

wallets        + space_id  NOT NULL -> spaces(id)
wallet_members + space_id  NOT NULL
categories     - wallet_id
               + space_id  NOT NULL -> spaces(id) ON DELETE CASCADE
transactions   + space_id  NOT NULL
recurring_rules+ space_id  NOT NULL
budgets        - category_key
               + space_id  NOT NULL
               + category_id -> categories(id)
budget_wallets + space_id  NOT NULL
```

`is_space_member(s uuid) returns boolean` mirrors `is_wallet_member` exactly:
`language sql stable security definer set search_path = ''`, reading
`space_members`. SECURITY DEFINER for the same reason — a policy on
`space_members` that queried `space_members` would recurse.

### 3.1 The invariant chain

Every "must belong to the same parent" rule stays a composite foreign key, the
idiom this schema already uses four times. Three unique constraints carry the
chain:

```sql
alter table wallets    add constraint wallets_id_space_unique    unique (id, space_id);
alter table categories add constraint categories_id_space_unique unique (id, space_id);
```

and the references hang off them:

```sql
-- a transaction's wallet must live in the transaction's space
transactions_wallet_same_space    (wallet_id, space_id)  -> wallets    (id, space_id)
-- a transaction's category must live in the same space
transactions_category_same_space  (category_id, space_id)-> categories (id, space_id)
-- you cannot be a member of a wallet without being a member of its space
wallet_members_wallet_same_space  (wallet_id, space_id)  -> wallets    (id, space_id)
wallet_members_in_space           (space_id, user_id)    -> space_members (space_id, user_id)
```

Two properties worth stating explicitly:

- `transactions.space_id` is denormalised, exactly as `currency_code` already
  is for `transactions_currency_matches_wallet`. It is not a second source of
  truth: `transactions_wallet_same_space` verifies it against the wallet on
  every write, so a wrong value is rejected rather than believed.
- MATCH SIMPLE (the default) skips a check when any referencing column is
  NULL. `transactions_category_same_space` therefore skips transfers, whose
  `category_id` is NULL — the same behaviour
  `transactions_category_same_wallet` has today. `space_id` is NOT NULL, so
  `transactions_wallet_same_space` always fires.

`wallet_members_in_space` is the load-bearing one. It makes the §1 invariant a
schema property: a row cannot exist granting wallet access to a user who
cannot read that wallet's categories. No trigger, no sync task, no drift.

### 3.2 Visibility widening — stated, not hidden

Space-scoped categories mean **every member of a space sees every category
name in it**, including categories only ever used in wallets they are not a
member of. This is a real widening over today's behaviour and is accepted:
it is the direct cost of one shared list, category names are low-sensitivity,
and no amounts, transactions or balances become reachable. Wallet membership
continues to gate everything else.

## 4. RLS and grants

```sql
create policy spaces_member on spaces
  for select to authenticated using (is_space_member(id));
create policy space_members_select on space_members
  for select to authenticated using (is_space_member(space_id));
create policy categories_space on categories
  for all to authenticated
  using (is_space_member(space_id)) with check (is_space_member(space_id));
```

`categories_space` has the same `USING`/`WITH CHECK` shape that
`0004` documented as escalatable and `0018` closed for categories: a
membership-scoped predicate is satisfiable on two *different* spaces at once,
so a user in two spaces could move a category out of one. The existing defence
carries over unchanged and must be preserved verbatim — `0018` revoked the
table-wide UPDATE and granted columns individually:

```sql
grant update (name, color_slot, icon, sort_order, archived_at) on categories to authenticated;
```

`space_id` is **not** in that list and must not be added.

### 4.1 Narrowing the table-wide grants

`0004` granted UPDATE table-wide on `profiles, wallets, wallet_members,
categories, transactions`, and Postgres grants are **additive** — a later
column-scoped `grant` never narrows an earlier table-wide one; only `revoke`
does. `0018` narrowed `categories`; `wallets` and `wallet_members` were left
untidy but unexploitable, because their policies are ownership- and
self-scoped rather than membership-scoped.

Adding `space_id` to those two tables changes that calculus, so `0022` must
narrow them:

```sql
revoke update on wallets from authenticated;
grant update (name, currency_code, initial_balance_minor, archived_at) on wallets to authenticated;

revoke update on wallet_members from authenticated;
grant update (role) on wallet_members to authenticated;
```

(The exact retained column lists are to be read off the current schema when
the migration is written, not copied from this document — the rule is
"everything currently updatable, minus `space_id`".)

This is what makes `transactions.space_id` safe to denormalise: a wallet
cannot change space, so a transaction's cached space cannot go stale. The
composite FKs are a second line of defence — `transactions_wallet_same_space`
has no `ON UPDATE CASCADE`, so even a privileged change to `wallets.space_id`
is rejected while transactions reference it — but the grant is the primary
one, matching how `0018` and `0020` close this class of problem.

`transactions` and `recurring_rules` need no revoke: their UPDATE grants are
already column-scoped, so a newly added `space_id` is excluded by default.

## 5. Migration `0022`, in order

Ordering matters here for the same reason it did in `0008` — the backfill
transiently violates constraints that are in force.

**A. Space infrastructure**
1. `spaces`, `space_members`, `is_space_member`.
2. Compute connected components over the graph whose nodes are wallets and
   whose edges join two wallets sharing at least one member. Implemented as a
   bounded merge loop in plpgsql that terminates when a full pass changes
   nothing. Insert one space per component, named from the component's
   most-common owner's `profiles.display_name`.
3. `wallets.space_id` nullable → backfill → NOT NULL → `wallets_id_space_unique`.
4. Backfill `space_members` from `wallet_members` joined through `wallets.space_id`.
5. `wallet_members.space_id` nullable → backfill → NOT NULL → both composite FKs.

**B. Categories**
6. `categories.space_id` nullable.
7. Per space, insert the merged set: `distinct on (kind, lower(btrim(name)))`
   across every wallet in that space. The surviving row's icon, colour and
   `sort_order` come from the variant with the most transactions attached,
   ties broken by oldest `created_at`, so customisation that is actually in
   use wins over an untouched default. An **active** variant always beats an
   archived one regardless of transaction count: the new unique index covers
   only `archived_at is null` rows, so collapsing an active row into an
   archived one would silently retire a category still in use.
8. Repoint `transactions.category_id` and `recurring_rules.category_id` onto
   the survivors.
9. **Guard:** assert zero rows in either table still reference a
   `wallet_id is not null` category. Raise and abort if not — a silent
   partial repoint is the failure mode `0008` step 6 also guarded against.
10. Drop `transactions_category_same_wallet`,
    `recurring_rules_category_same_wallet`, `budgets_category_same_wallet`,
    the old unique index, and `categories_id_wallet_unique`.
11. Delete the old wallet-scoped rows; drop `categories.wallet_id`; set
    `space_id` NOT NULL.
12. `create unique index categories_unique_active_name on categories
    (space_id, kind, lower(btrim(name))) where archived_at is null;`
    plus `categories_id_space_unique`.

**C. Space id on the dependants**
13. `transactions.space_id` and `recurring_rules.space_id`: nullable →
    backfill from the wallet → NOT NULL → composite FKs from §3.1.

**D. Budgets** (§6)

**E. Policies, grants, seeding** (§4, §7)

### 5.1 Pre-flight verification

Because the component rule is data-dependent, the plan runs this against the
hosted database and confirms it returns `1` before `0022` is applied:

```sql
select count(distinct owner_id) from wallets where archived_at is null;
```

If it returns more than one, the merge loop still produces a single space
provided the wallets share a member — but the result must be confirmed
deliberately rather than assumed.

## 6. Budgets conversion

`budgets.category_key` exists only because wallet scoping left no id to point
at. Space scoping restores one:

- Add `budgets.space_id` and `budgets.category_id`.
- Backfill `category_id` by matching `category_key` against
  `lower(btrim(categories.name))` within the budget's space. A budget whose
  key matches nothing keeps `category_id` NULL and is reported by the
  migration rather than dropped.
- Drop `category_key` and its normalisation CHECK.
- `budget_wallets` gains `space_id` with composite FKs to
  `wallets(id, space_id)` and `budgets(id, space_id)`, so a budget's wallet
  set cannot span spaces.
- Rewrite `get_budget_status` and `set_budget` against ids. Per `0013`'s own
  hard-won note, both must be dropped **explicitly** — PL/pgSQL function
  bodies are opaque to Postgres dependency tracking, so `drop ... cascade` on
  a table does not reach a function that queries it, leaving it silently
  broken rather than gone.

## 7. Seeding

Seeding moves one level up, mirroring what `0008` did when it moved from the
user trigger to the wallet trigger:

- `seed_wallet_categories` and its `wallets_seed_categories` trigger are
  dropped. **A new wallet seeds no categories.** This is the fix for nine
  wallets meaning 144 rows.
- A new `spaces_seed_categories` trigger seeds the 16 defaults on space insert.
- `handle_new_user` (0007, rewritten by 0008) additionally creates the new
  user's space and their `space_members` row, so a brand-new account has
  exactly one space and one category list before it has any wallet.
- Wallet creation resolves `space_id` from the creator's space rather than
  accepting it from the client.

## 8. Application changes

| Area | Change |
|---|---|
| `/categories` | Wallet chip row removed. One list. A user in more than one space (uncommon — only via an invite from another household) gets a space selector in its place. |
| `transactions/new`, `transactions/[id]/edit` | Category query drops its `.in("wallet_id", …)` filter and its per-wallet client-side filtering; the picker offers the space's categories regardless of selected wallet. |
| `move_transaction` (0020) | Unchanged in rule, but the destination-wallet check gains the space check implicitly through the new composite FKs. Its member-superset rule stands as-is. |
| `get_category_breakdown` (0011) | Joins on the space's categories; no longer able to double-count identically named rows from sibling wallets. |
| Server actions | `categories.ts` drops `wallet_id` from create/update input and derives `space_id` from the session. |
| Types | `db:types` regeneration. |

## 9. Testing

- **`supabase/tests/rls.sql`** — a user in two spaces cannot move a category
  between them (the `0018` escalation, re-proved under the new policy); a
  wallet member always reads the categories their transactions reference (the
  `0008` bug, now proved structurally); `wallet_members` cannot be inserted for
  a non-space-member; a space member cannot read another space's categories.
- **`supabase/tests/constraints.sql`** — every composite FK from §3.1 rejects
  its violation; a transfer with NULL `category_id` still inserts.
- **Migration correctness** — a test fixture with two wallets holding
  `Transport` and `Public Transport` plus transactions against both proves
  step 7 keeps both and step 8 repoints every transaction, with zero rows
  landing on a dropped category.
- **Vitest** — updated `page.test.tsx` for both transaction forms, asserting a
  category created in one wallet is offered when editing a transaction in
  another. That assertion fails today and is the direct regression test for
  the reported bug.

## 10. Out of scope

- Inviting a user into a space independently of a wallet invite. Space
  membership continues to arrive via wallet membership.
- Per-space category ordering or per-user category preferences.
- Merging two existing spaces.
- Un-archiving wallets (a pre-existing gap, unrelated).

## 11. Risks

| Risk | Mitigation |
|---|---|
| Largest migration in the project; touches six tables and four functions. | Step 9's guard aborts on any un-repointed row. Applied to local `db reset` and the full SQL suites before hosted. |
| Hosted database has drifted before (dump-restore left it with no migration tracking, and carries anon-grant drift). | `migration list --linked` confirmed clean before push; `0022` is additive-then-destructive in one transaction, so a failure rolls back whole. |
| `category_key` backfill may not match every budget. | Unmatched budgets keep NULL and are reported, not deleted. |
| Visibility widening (§3.2). | Accepted and documented; category names only. |

## 12. Implementation notes (2026-09-05)

Where the shipped migrations differ from the sections above, and why.

| Section | Departure |
|---|---|
| §2, §6 | Budgets are converted in **`0023`**, a separate transaction, not inside `0022`. `0022` lands with budgets still working by name, so a failure in the budgets conversion rolls back to a schema that runs rather than to one half-converted. |
| §6 | A `category_key` that matches nothing does **not** keep `category_id` NULL. NULL now *means* the overall cap, so that would silently turn a budget over a vanished category into a cap on all spending. Instead `0023` mints an **archived** expense category named from the key (hidden from pickers, still resolves a label) and reports each one with `raise notice`. Behaviour is unchanged: the row renders under its old label with zero spend, as it did before. |
| §6 | Wallet-less budgets (unreachable by anyone since `0013` closed its HAZARD) are deleted by `0023` and counted aloud; `budgets.space_id NOT NULL` cannot hold with them present. |
| §5 step 9 | The un-repointed-row guard is implemented as the `ON DELETE RESTRICT` on `transactions.category_id` / `recurring_rules.category_id` biting during the loser DELETE, plus an explicit count afterwards — a missed repoint aborts the transaction either way. |
| §7 | New households seed colour slots **1..16** (one per default), not the wrapped 1..8 `0008` used against the old 8-colour palette (`0017` widened it). Existing rows keep their slots through the merge. |
| §8 | `recurring_rules` gained a second FK to `wallets`, so its two `wallets(...)` embeds are pinned with `!recurring_rules_wallet_id_fkey` — the class of break `scripts/check-embeds.sh` exists for. |
| §9 | The migration-correctness fixture is `supabase/tests/migration_0022.sql`, run by `npm run test:migration:0022`, which resets to `0021`, plants the fixture, applies `0022` then `0023` each in one transaction, and asserts. |
| — | `set_budget` refuses a category from another household, a nonexistent id, and an **income** category; the last is new (a name could previously match either kind). A wallet set spanning two households is refused in words before the composite FKs would refuse it anyway. |

A read-only `/household` screen was added after review (0024 `get_space_members()`, Sidebar entry, link from `/categories`). It lists each household's members and the wallets the viewer is in; membership stays derived, per §10.

§5.1's pre-flight check was run against the hosted database on 2026-09-05; see the session notes for the result. Hosted migrations are applied by hand.
