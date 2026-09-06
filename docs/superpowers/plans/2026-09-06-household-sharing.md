# Household Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A household owner invites and removes people from `/household`; each wallet's owner shares it with the whole household, with specific housemates, or keeps it private; a member who leaves takes the wallets they own into a fresh household.

**Architecture:** `wallet_members` stays the only source of truth for wallet access (materialised membership). A `via` column records why each row exists (`owner` / `household` / `direct`); a flag on `wallets` plus one trigger on `space_members` keep the `household` rows in step. Every write goes through SECURITY DEFINER SQL functions; the app calls them through thin server actions; one shared React control renders a wallet's sharing on both `/household` and `/wallets`.

**Tech Stack:** Next.js 16 App Router (Server Components + Server Actions), Supabase Postgres 17 with RLS, Zod 4, Vitest + Testing Library, Playwright, psql-driven SQL suites under `supabase/tests/`.

**Spec:** `docs/superpowers/specs/2026-09-06-household-sharing-design.md`

## Global Constraints

- All new SQL functions: `language plpgsql` (or `sql`) `security definer set search_path = ''`; every relation schema-qualified (`public.` / `auth.`); `revoke all on function … from public, anon; grant execute … to authenticated`.
- New tables: `enable row level security`, `revoke all … from anon, authenticated` first, then grant exactly what is needed.
- Server actions return `{ error?: string; notice?: string }`; never throw; never forward a raw database message to the user.
- Error copy from `set_wallet_sharing` and friends is internal; the action maps it to app-authored text.
- Migration file is `supabase/migrations/0025_household_sharing.sql`, grown across Tasks 1–4. Each task appends a clearly headed section and re-runs `npx supabase db reset --no-seed`.
- Local stack ports: API `54331`, DB `54332` (see `supabase/config.toml`). Start it with `npx supabase start` before Task 1; the SQL runners reset the database themselves.
- Run `npm run db:types` after every migration change and commit `src/lib/database.types.ts` with it.
- Copy: "household", never "space", in anything a user reads. "Housemate" is fine for another member.
- Commit after every task with a message in this repo's style (`feat:` / `fix:` / `test:` prefix, sentence-case summary, wrapped body explaining why).

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0025_household_sharing.sql` | Schema, triggers, functions, grants (Tasks 1–4). |
| `supabase/tests/constraints.sql` | Invariants and guards, superuser scope (Tasks 1, 2, 4). |
| `supabase/tests/rls.sql` | Visibility under impersonation (Tasks 2, 3, 4). |
| `supabase/tests/leave_space.sql` + `scripts/test-leave-space.sh` | Fixture proof of the leave routine (Task 4). |
| `src/server/actions/household.ts` (+ `.test.ts`) | Server actions over the new RPCs (Task 5). |
| `src/server/actions/invites.ts` (+ `.test.ts`) | `removeMember` rewritten onto `set_wallet_sharing` (Task 5). |
| `src/components/WalletSharingRow.tsx` (+ `.test.tsx`) | The one sharing control: household switch + direct checkboxes + save (Task 6). |
| `src/components/InviteByEmailForm.tsx` | Email form lifted out of `MembersSection`, parameterised by action (Task 7). |
| `src/app/(app)/household/HouseholdSection.tsx` (+ `.test.tsx`) | Members, invitations, leave/remove, sharing grid for one household (Task 7). |
| `src/app/(app)/household/page.tsx` (+ `.test.tsx`) | Loads and hands data to `HouseholdSection` (Task 7). |
| `src/app/(app)/wallets/MembersSection.tsx`, `PendingInvites.tsx`, `page.tsx` (+ tests) | Sharing row per wallet; household invitations listed (Task 8). |
| `e2e/sharing.spec.ts` | Household invite → share → leave path (Task 9). |

---

### Task 1: Schema — `via`, the household flag, one owner, deferrable keys, no direct writes

**Files:**
- Create: `supabase/migrations/0025_household_sharing.sql`
- Modify: `supabase/tests/constraints.sql` (append)
- Modify: `src/lib/database.types.ts` (regenerated)

**Interfaces:**
- Produces: enum `member_via`; `wallet_members.via member_via not null default 'direct'`; `wallets.shared_with_household boolean not null default false`; `add_owner_as_member()` writes `via = 'owner'`; `members_write` policy gone and `insert/update/delete on wallet_members` revoked from `authenticated`.

- [ ] **Step 1: Write the failing constraints test**

Append to `supabase/tests/constraints.sql`, before the final line of the file:

```sql
-- =====================================================================
-- 0025: membership provenance and the end of direct wallet_members writes
-- =====================================================================
insert into auth.users (id, email) values
  ('a5a50000-0000-4000-8000-000000000001', 'hs-owner@x.io'),
  ('a5a50000-0000-4000-8000-000000000002', 'hs-mate@x.io');
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('a5a50000-0000-4000-8000-00000000000a', 'a5a50000-0000-4000-8000-000000000001', 'HS Main', 'bank', 'SGD', 1, 'landmark');

do $$ begin
  -- add_owner_as_member records WHY the row exists.
  assert (select via from wallet_members
           where wallet_id = 'a5a50000-0000-4000-8000-00000000000a'
             and user_id = 'a5a50000-0000-4000-8000-000000000001') = 'owner',
    '0025 BROKEN: the owner''s membership row is not via = owner';
  assert (select shared_with_household from wallets where id = 'a5a50000-0000-4000-8000-00000000000a') = false,
    '0025 BROKEN: a new wallet is not private by default';
end $$;

-- accept_wallet_invite (0022) inserts without naming via; the default must
-- make that a DIRECT share, not a household one.
insert into wallet_invites (id, wallet_id, invited_email, invited_by)
values ('a5a50000-0000-4000-8000-0000000000e1', 'a5a50000-0000-4000-8000-00000000000a',
        'hs-mate@x.io', 'a5a50000-0000-4000-8000-000000000001');
begin;
  set local request.jwt.claims = '{"sub":"a5a50000-0000-4000-8000-000000000002","email":"hs-mate@x.io"}';
  select accept_wallet_invite('a5a50000-0000-4000-8000-0000000000e1');
commit;
do $$ begin
  assert (select via from wallet_members
           where wallet_id = 'a5a50000-0000-4000-8000-00000000000a'
             and user_id = 'a5a50000-0000-4000-8000-000000000002') = 'direct',
    '0025 BROKEN: an accepted wallet invite is not via = direct';
end $$;

-- No direct writes to wallet_members for authenticated, at the privilege
-- boundary: a wallet OWNER (who members_write used to admit) is refused.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"a5a50000-0000-4000-8000-000000000001","email":"hs-owner@x.io"}';
  do $$ begin
    begin
      delete from public.wallet_members
       where wallet_id = 'a5a50000-0000-4000-8000-00000000000a'
         and user_id = 'a5a50000-0000-4000-8000-000000000002';
      raise exception 'LEAK: the wallet owner could DELETE from wallet_members directly';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.wallet_members (wallet_id, user_id, role)
      values ('a5a50000-0000-4000-8000-00000000000a', 'a5a50000-0000-4000-8000-000000000001', 'member');
      raise exception 'LEAK: the wallet owner could INSERT into wallet_members directly';
    exception when insufficient_privilege then null;
    end;
    assert (select count(*) from public.wallet_members where wallet_id = 'a5a50000-0000-4000-8000-00000000000a') = 2,
      'PERMISSION BROKEN: a member cannot still SELECT wallet_members';
  end $$;
commit;

-- One owner per household: the earliest-joined owner stays, others demote.
do $$
declare v_space uuid;
begin
  select space_id into v_space from wallets where id = 'a5a50000-0000-4000-8000-00000000000a';
  assert (select count(*) from space_members where space_id = v_space and role = 'owner') = 1,
    '0025 BROKEN: a household has more than one owner';
end $$;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:constraints`
Expected: FAIL at the first assertion with `column "via" does not exist`.

- [ ] **Step 3: Write the migration section**

Create `supabase/migrations/0025_household_sharing.sql`:

```sql
-- supabase/migrations/0025_household_sharing.sql
--
-- Household sharing (design 2026-09-06). wallet_members remains the ONE
-- source of truth for who can read a wallet -- nothing under
-- is_wallet_member changes -- but each row now says WHY it exists, so a
-- household-wide share can be withdrawn without touching a share the
-- owner granted by hand. See the spec's §3.3 for the invariants.

-- ─────────────────────────────────────────────────────────────────────────
-- A. Provenance on wallet_members, a share flag on wallets
-- ─────────────────────────────────────────────────────────────────────────
create type member_via as enum ('owner', 'household', 'direct');

-- Default 'direct': accept_wallet_invite (0022) inserts without naming via
-- and an accepted invite IS a direct share. add_owner_as_member names
-- 'owner' explicitly below; only set_wallet_sharing and the space_members
-- trigger ever write 'household'.
alter table wallet_members add column via member_via not null default 'direct';
update wallet_members m set via = 'owner'
  from wallets w where w.id = m.wallet_id and w.owner_id = m.user_id;

alter table wallets add column shared_with_household boolean not null default false;

create or replace function add_owner_as_member() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.wallet_members (wallet_id, user_id, role, via)
  values (new.id, new.owner_id, 'owner', 'owner');
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- B. Exactly one owner per household
-- ─────────────────────────────────────────────────────────────────────────
-- 0022 marked everyone who owned any wallet in a household as its owner.
-- Only the owner may invite and remove people now, so that must be one
-- person: the earliest-joined keeps the role. Reported, because on the
-- hosted database this demotes a real person.
do $$
declare r record;
begin
  for r in
    select sm.space_id, sm.user_id, sm.joined_at
      from public.space_members sm
     where sm.role = 'owner'
       and exists (select 1 from public.space_members o
                    where o.space_id = sm.space_id and o.role = 'owner'
                      and (o.joined_at, o.user_id) < (sm.joined_at, sm.user_id))
  loop
    update public.space_members set role = 'member'
     where space_id = r.space_id and user_id = r.user_id;
    raise notice '0025: demoted % to member of household % (a later owner)', r.user_id, r.space_id;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- C. Composite keys become deferrable
-- ─────────────────────────────────────────────────────────────────────────
-- leave_space (section G) moves a wallet, its members, transactions, rules
-- and budget links to another household inside one transaction. Each of
-- these keys would refuse the intermediate states, so they are checked at
-- commit when a transaction asks for that (SET CONSTRAINTS ALL DEFERRED)
-- and, as before, at statement end otherwise. INITIALLY IMMEDIATE means
-- no behaviour changes for any other caller.
alter table wallet_members  alter constraint wallet_members_wallet_same_space   deferrable initially immediate;
alter table wallet_members  alter constraint wallet_members_in_space            deferrable initially immediate;
alter table transactions    alter constraint transactions_wallet_same_space     deferrable initially immediate;
alter table transactions    alter constraint transactions_category_same_space   deferrable initially immediate;
alter table recurring_rules alter constraint recurring_rules_wallet_same_space  deferrable initially immediate;
alter table recurring_rules alter constraint recurring_rules_category_same_space deferrable initially immediate;
alter table budgets         alter constraint budgets_category_same_space        deferrable initially immediate;
alter table budget_wallets  alter constraint budget_wallets_wallet_same_space   deferrable initially immediate;
alter table budget_wallets  alter constraint budget_wallets_budget_same_space   deferrable initially immediate;

-- ─────────────────────────────────────────────────────────────────────────
-- D. No direct writes to wallet_members
-- ─────────────────────────────────────────────────────────────────────────
-- Every insert and delete now goes through set_wallet_sharing,
-- accept_wallet_invite, add_owner_as_member and the space_members trigger
-- (section E). That is what makes "a household row exists iff the wallet
-- is shared and you are in the household" a property nothing can break by
-- hand. Postgres grants are additive, so the 0004 grant is REVOKED, not
-- merely left un-granted (0018 and 0022 make the same point).
drop policy members_write on wallet_members;
revoke insert, update, delete on wallet_members from authenticated;
```

- [ ] **Step 4: Reset, run the suites, regenerate types**

Run: `npm run test:constraints && npm run test:rls && npm run db:types`
Expected: both suites pass. If `rls.sql` fails on an `insert into wallet_members` under `set local role authenticated` (the 0018 block and the set_budget section both do this as the wallet owner), those fixtures now belong at superuser scope: move the insert above the `begin; set local role …` line of that block and re-run. Note each move in a one-line comment (`-- 0025: superuser scope, members_write is gone`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0025_household_sharing.sql supabase/tests/constraints.sql supabase/tests/rls.sql src/lib/database.types.ts
git commit -m "feat: record why a wallet member row exists, and stop direct writes to it"
```

---

### Task 2: `set_wallet_sharing` and the join trigger

**Files:**
- Modify: `supabase/migrations/0025_household_sharing.sql` (append sections E, F)
- Modify: `supabase/tests/constraints.sql`, `supabase/tests/rls.sql` (append)

**Interfaces:**
- Produces: `set_wallet_sharing(p_wallet uuid, p_household boolean, p_direct uuid[]) returns void`; trigger `space_members_grant_shares`.
- Resolution rule (drives Task 6's UI): one row per (wallet, user). `direct` outranks `household`. Sharing with the household adds `household` rows only where no row exists; unsharing deletes `household` rows and leaves `direct` ones; a user removed from the direct list becomes `household` if the wallet is household-shared, else loses the row.

- [ ] **Step 1: Write the failing constraints test**

Append to `supabase/tests/constraints.sql`:

```sql
-- set_wallet_sharing and the join trigger hold the household-row invariant.
insert into auth.users (id, email) values ('a5a50000-0000-4000-8000-000000000003', 'hs-third@x.io');
-- hs-third joins the household by accepting an invite onto HS Main (direct).
insert into wallet_invites (id, wallet_id, invited_email, invited_by)
values ('a5a50000-0000-4000-8000-0000000000e2', 'a5a50000-0000-4000-8000-00000000000a',
        'hs-third@x.io', 'a5a50000-0000-4000-8000-000000000001');
begin;
  set local request.jwt.claims = '{"sub":"a5a50000-0000-4000-8000-000000000003","email":"hs-third@x.io"}';
  select accept_wallet_invite('a5a50000-0000-4000-8000-0000000000e2');
commit;
-- A second wallet of the owner's, private so far.
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('a5a50000-0000-4000-8000-00000000000b', 'a5a50000-0000-4000-8000-000000000001', 'HS Second', 'bank', 'SGD', 2, 'wallet');

begin;
  set local request.jwt.claims = '{"sub":"a5a50000-0000-4000-8000-000000000001","email":"hs-owner@x.io"}';

  -- REJECT: not the owner.
  do $$
  declare v_ok boolean := false;
  begin
    perform set_config('request.jwt.claims', '{"sub":"a5a50000-0000-4000-8000-000000000002"}', true);
    begin
      perform set_wallet_sharing('a5a50000-0000-4000-8000-00000000000b', true, array[]::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'only the wallet owner can change who it is shared with', format('wrong error: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: a non-owner changed a wallet''s sharing';
    perform set_config('request.jwt.claims', '{"sub":"a5a50000-0000-4000-8000-000000000001"}', true);
  end $$;

  -- REJECT: a direct share to someone outside the household.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_wallet_sharing('a5a50000-0000-4000-8000-00000000000b', false,
        array['dddddddd-0000-0000-0000-0000000000d1']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'a wallet can only be shared with people in its household', format('wrong error: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: a wallet was shared with someone outside its household';
  end $$;

  -- ACCEPT: share with the household -> one household row per other member.
  do $$ begin
    perform set_wallet_sharing('a5a50000-0000-4000-8000-00000000000b', true, array[]::uuid[]);
    assert (select shared_with_household from public.wallets where id = 'a5a50000-0000-4000-8000-00000000000b'),
      'set_wallet_sharing did not set the flag';
    assert (select array_agg(user_id::text order by user_id) from public.wallet_members
             where wallet_id = 'a5a50000-0000-4000-8000-00000000000b' and via = 'household')
         = array['a5a50000-0000-4000-8000-000000000002', 'a5a50000-0000-4000-8000-000000000003'],
      'household rows were not created for every other member';
  end $$;

  -- ACCEPT: a direct share alongside; then unshare the household -> the
  -- direct row survives, the household rows go.
  do $$ begin
    perform set_wallet_sharing('a5a50000-0000-4000-8000-00000000000b', true,
      array['a5a50000-0000-4000-8000-000000000002']::uuid[]);
    assert (select via from public.wallet_members where wallet_id = 'a5a50000-0000-4000-8000-00000000000b'
             and user_id = 'a5a50000-0000-4000-8000-000000000002') = 'direct',
      'a direct share did not outrank the household row';
    perform set_wallet_sharing('a5a50000-0000-4000-8000-00000000000b', false,
      array['a5a50000-0000-4000-8000-000000000002']::uuid[]);
    assert (select array_agg(via::text order by via) from public.wallet_members
             where wallet_id = 'a5a50000-0000-4000-8000-00000000000b')
         = array['direct', 'owner'],
      'unsharing the household did not leave exactly the owner and the direct share';
  end $$;

  -- ACCEPT: dropping the direct share on a private wallet removes the row.
  do $$ begin
    perform set_wallet_sharing('a5a50000-0000-4000-8000-00000000000b', false, array[]::uuid[]);
    assert (select count(*) from public.wallet_members where wallet_id = 'a5a50000-0000-4000-8000-00000000000b') = 1,
      'a withdrawn direct share left its row behind';
  end $$;
commit;

-- The join trigger: a new household member is granted every shared wallet.
begin;
  set local request.jwt.claims = '{"sub":"a5a50000-0000-4000-8000-000000000001","email":"hs-owner@x.io"}';
  select set_wallet_sharing('a5a50000-0000-4000-8000-00000000000b', true, array[]::uuid[]);
commit;
insert into auth.users (id, email) values ('a5a50000-0000-4000-8000-000000000004', 'hs-fourth@x.io');
insert into space_members (space_id, user_id, role)
values ((select space_id from wallets where id = 'a5a50000-0000-4000-8000-00000000000a'),
        'a5a50000-0000-4000-8000-000000000004', 'member');
do $$ begin
  assert (select via from wallet_members where wallet_id = 'a5a50000-0000-4000-8000-00000000000b'
           and user_id = 'a5a50000-0000-4000-8000-000000000004') = 'household',
    'TRIGGER BROKEN: a new household member was not granted the shared wallet';
  assert not exists (select 1 from wallet_members where wallet_id = 'a5a50000-0000-4000-8000-00000000000a'
           and user_id = 'a5a50000-0000-4000-8000-000000000004'),
    'TRIGGER BROKEN: a new household member was granted a PRIVATE wallet';
end $$;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:constraints`
Expected: FAIL with `function set_wallet_sharing(uuid, boolean, uuid[]) does not exist`.

- [ ] **Step 3: Append the migration sections**

```sql
-- ─────────────────────────────────────────────────────────────────────────
-- E. Joining a household grants its shared wallets
-- ─────────────────────────────────────────────────────────────────────────
-- Leaving needs no trigger: wallet_members_in_space (0022) is ON DELETE
-- CASCADE, so deleting a space_members row already removes that user's
-- rows on every wallet in the household. leave_space (section G) moves the
-- wallets they own out first, so the cascade never reaches an owner row.
create function grant_household_shares() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.wallet_members (wallet_id, user_id, role, via)
  select w.id, new.user_id, 'member', 'household'
    from public.wallets w
   where w.space_id = new.space_id
     and w.shared_with_household
     and w.owner_id <> new.user_id
  on conflict (wallet_id, user_id) do nothing;
  return new;
end $$;

create trigger space_members_grant_shares after insert on space_members
  for each row execute function grant_household_shares();

-- ─────────────────────────────────────────────────────────────────────────
-- F. set_wallet_sharing: the one way to change who sees a wallet
-- ─────────────────────────────────────────────────────────────────────────
-- One row per (wallet, user), and 'direct' outranks 'household': a share
-- the owner granted by hand outlives a later household unshare. Reconciles
-- to the requested state rather than toggling, so the UI can submit a
-- whole row and a retried request is harmless.
create function set_wallet_sharing(p_wallet uuid, p_household boolean, p_direct uuid[])
  returns void
  language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_space uuid;
  v_bad   int;
begin
  select w.owner_id, w.space_id into v_owner, v_space from public.wallets w where w.id = p_wallet;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'only the wallet owner can change who it is shared with';
  end if;
  p_direct := coalesce(p_direct, array[]::uuid[]);
  if v_owner = any(p_direct) then
    raise exception 'the owner is always a member';
  end if;
  select count(*) into v_bad
    from unnest(p_direct) u(id)
   where not exists (select 1 from public.space_members sm
                      where sm.space_id = v_space and sm.user_id = u.id);
  if v_bad > 0 then
    raise exception 'a wallet can only be shared with people in its household';
  end if;

  update public.wallets set shared_with_household = p_household where id = p_wallet;

  -- Direct rows first, so a household row never displaces one.
  insert into public.wallet_members (wallet_id, user_id, role, via)
  select p_wallet, u.id, 'member', 'direct' from unnest(p_direct) u(id)
  on conflict (wallet_id, user_id) do update set via = 'direct'
    where public.wallet_members.via = 'household';

  if p_household then
    -- Formerly-direct members not in p_direct stay, as household members.
    update public.wallet_members set via = 'household'
     where wallet_id = p_wallet and via = 'direct' and not (user_id = any(p_direct));
    insert into public.wallet_members (wallet_id, user_id, role, via)
    select p_wallet, sm.user_id, 'member', 'household'
      from public.space_members sm
     where sm.space_id = v_space and sm.user_id <> v_owner
    on conflict (wallet_id, user_id) do nothing;
  else
    delete from public.wallet_members
     where wallet_id = p_wallet and via = 'household';
    delete from public.wallet_members
     where wallet_id = p_wallet and via = 'direct' and not (user_id = any(p_direct));
  end if;
end $$;

revoke all on function set_wallet_sharing(uuid, boolean, uuid[]) from public, anon;
grant execute on function set_wallet_sharing(uuid, boolean, uuid[]) to authenticated;
```

- [ ] **Step 4: Run the constraints suite**

Run: `npm run test:constraints`
Expected: PASS.

- [ ] **Step 5: Write the RLS test**

Append to `supabase/tests/rls.sql`:

```sql
-- =====================================================================
-- 0025: a household-shared wallet is readable by a joiner with no extra
-- rows; unsharing revokes it; a direct share alongside survives; the
-- HOUSEHOLD owner cannot change a wallet they do not own.
-- =====================================================================
insert into auth.users (id, email) values
  ('b5b50000-0000-4000-8000-000000000001', 'hh-owner@x.io'),
  ('b5b50000-0000-4000-8000-000000000002', 'hh-mate@x.io');
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000001","email":"hh-owner@x.io"}';
  insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
    ('b5b50000-0000-4000-8000-00000000000a', 'b5b50000-0000-4000-8000-000000000001', 'HH Shared', 'bank', 'USD', 1, 'landmark'),
    ('b5b50000-0000-4000-8000-00000000000b', 'b5b50000-0000-4000-8000-000000000001', 'HH Private', 'bank', 'USD', 2, 'wallet');
  insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
    values ('b5b50000-0000-4000-8000-00000000000a', 'b5b50000-0000-4000-8000-000000000001', 'expense', -100, 'USD', '2026-09-01');
  select set_wallet_sharing('b5b50000-0000-4000-8000-00000000000a', true, array[]::uuid[]);
commit;
-- hh-mate joins the household (superuser scope: this is the fixture, not
-- the thing under test; Task 3's accept_space_invite is the real path).
insert into public.space_members (space_id, user_id, role)
values ((select space_id from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000a'),
        'b5b50000-0000-4000-8000-000000000002', 'member');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000002","email":"hh-mate@x.io"}';
  do $$ begin
    assert (select count(*) from public.transactions where wallet_id = 'b5b50000-0000-4000-8000-00000000000a') = 1,
      'PERMISSION BROKEN: a household member cannot read a household-shared wallet''s transactions';
    assert (select count(*) from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000b') = 0,
      'LEAK: a household member can see a housemate''s PRIVATE wallet';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000001","email":"hh-owner@x.io"}';
  select set_wallet_sharing('b5b50000-0000-4000-8000-00000000000a', false, array[]::uuid[]);
commit;
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000002","email":"hh-mate@x.io"}';
  do $$ begin
    assert (select count(*) from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000a') = 0,
      'LEAK: unsharing a wallet from the household did not revoke a member''s access';
  end $$;
commit;

-- The household owner (hh-owner) owns the household; hh-mate owns a wallet in
-- it. hh-owner must NOT be able to change hh-mate's wallet.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000002","email":"hh-mate@x.io"}';
  insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
    ('b5b50000-0000-4000-8000-00000000000c', 'b5b50000-0000-4000-8000-000000000002', 'Mate Own', 'bank', 'USD', 3, 'wallet');
commit;
do $$ begin
  assert (select space_id from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000c')
       = (select space_id from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000a'),
    'test setup broken: hh-mate''s wallet did not land in the shared household';
end $$;
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000001","email":"hh-owner@x.io"}';
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_wallet_sharing('b5b50000-0000-4000-8000-00000000000c', true, array[]::uuid[]);
      v_ok := true;
    exception when others then null;
    end;
    assert not v_ok, 'ESCALATION: the household owner changed the sharing of a wallet they do not own';
  end $$;
commit;
```

Note: `set_wallet_space` (0022) files hh-mate's wallet into the household hh-mate *owns first*. hh-mate owns their own signup household, so `Mate Own` would land there, not in hh-owner's household, and the setup assertion above would fail. Fix this in the migration, not the test: in section F's neighbourhood add

```sql
-- set_wallet_space (0022) preferred the household the creator OWNS. With
-- one owner per household that is always their signup household, so a
-- member could never create a wallet inside the household they joined.
-- Prefer the household most recently joined; the signup one is the oldest.
create or replace function set_wallet_space() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_space uuid;
begin
  select sm.space_id into v_space
    from public.space_members sm
   where sm.user_id = new.owner_id
   order by sm.joined_at desc
   limit 1;
  if v_space is null then
    insert into public.spaces (name) values ('Household') returning id into v_space;
    insert into public.space_members (space_id, user_id, role)
      values (v_space, new.owner_id, 'owner');
  end if;
  new.space_id := v_space;
  return new;
end $$;
```

and append this to the plan's spec-departures note in Task 9 Step 5.

- [ ] **Step 6: Run both suites**

Run: `npm run test:constraints && npm run test:rls && npm run test:seed && npm run db:types`
Expected: all PASS. (`seed.sql` asserts a fresh user's two wallets land in their own household — still true, they belong to exactly one.)

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0025_household_sharing.sql supabase/tests/constraints.sql supabase/tests/rls.sql src/lib/database.types.ts
git commit -m "feat: share a wallet with the whole household, or with chosen housemates"
```

---

### Task 3: Household invitations

**Files:**
- Modify: `supabase/migrations/0025_household_sharing.sql` (append section H)
- Modify: `supabase/tests/rls.sql` (append)

**Interfaces:**
- Produces: table `space_invites`; `invite_to_space(p_space uuid, p_email text) returns uuid`; `revoke_space_invite(p_invite uuid) returns void`; `accept_space_invite(p_invite uuid) returns void`; `decline_space_invite(p_invite uuid) returns void`; `get_pending_space_invites() returns table(id uuid, space_id uuid, space_name text, invited_by_name text, created_at timestamptz)`.

- [ ] **Step 1: Write the failing RLS test**

Append to `supabase/tests/rls.sql`:

```sql
-- =====================================================================
-- 0025: household invitations. Owner-only to send and revoke; invitee
-- matched on JWT email to accept; accepting grants every household-shared
-- wallet through the join trigger.
-- =====================================================================
insert into auth.users (id, email) values ('b5b50000-0000-4000-8000-000000000003', 'hh-new@x.io');
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000001","email":"hh-owner@x.io"}';
  select set_wallet_sharing('b5b50000-0000-4000-8000-00000000000a', true, array[]::uuid[]);
  do $$
  declare v_id uuid;
  begin
    v_id := invite_to_space((select space_id from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000a'), 'HH-New@x.io ');
    assert v_id is not null, 'PERMISSION BROKEN: the household owner could not send an invitation';
    assert (select invited_email from public.space_invites where id = v_id) = 'hh-new@x.io',
      'invite_to_space did not normalise the address';
    assert (select count(*) from public.space_invites where id = v_id) = 1,
      'PERMISSION BROKEN: the owner cannot read the invitation they sent';
  end $$;
commit;

-- A non-owner member cannot invite.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000002","email":"hh-mate@x.io"}';
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform invite_to_space((select space_id from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000c'), 'x@x.io');
      v_ok := true;
    exception when others then
      assert sqlerrm = 'only the household owner can invite people', format('wrong error: %s', sqlerrm);
    end;
    assert not v_ok, 'ESCALATION: a non-owner member sent a household invitation';
    assert (select count(*) from public.space_invites) = 0,
      'LEAK: a member who is not the owner and not the invitee can read household invitations';
  end $$;
commit;

-- The invitee sees it, a stranger to the address cannot accept it, the
-- invitee can, and then holds the household-shared wallet.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000003","email":"hh-new@x.io"}';
  do $$
  declare v_id uuid;
  begin
    select id into v_id from public.get_pending_space_invites();
    assert v_id is not null, 'PERMISSION BROKEN: the invitee cannot see a household invitation addressed to them';
    assert (select space_name from public.get_pending_space_invites() where id = v_id) like '%household%',
      'get_pending_space_invites did not carry the household name';
    perform set_config('request.jwt.claims', '{"sub":"b5b50000-0000-4000-8000-000000000002","email":"hh-mate@x.io"}', true);
    begin
      perform accept_space_invite(v_id);
      raise exception 'LEAK: someone other than the invitee accepted a household invitation';
    exception when others then
      assert sqlerrm = 'invite is addressed to someone else', format('wrong error: %s', sqlerrm);
    end;
    perform set_config('request.jwt.claims', '{"sub":"b5b50000-0000-4000-8000-000000000003","email":"hh-new@x.io"}', true);
    perform accept_space_invite(v_id);
    assert (select status from public.space_invites where id = v_id) = 'accepted', 'accept did not mark the invite';
    assert (select count(*) from public.transactions where wallet_id = 'b5b50000-0000-4000-8000-00000000000a') = 1,
      'PERMISSION BROKEN: accepting a household invitation did not grant the household-shared wallet';
    assert (select count(*) from public.get_pending_space_invites()) = 0, 'an accepted invite is still pending';
  end $$;
commit;

do $$ begin
  assert has_function_privilege('authenticated', 'public.invite_to_space(uuid,text)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.accept_space_invite(uuid)', 'EXECUTE'),
    'GRANT BROKEN: household invite functions are not scoped to authenticated';
end $$;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:rls`
Expected: FAIL with `function invite_to_space(uuid, unknown) does not exist`.

- [ ] **Step 3: Append the migration section**

```sql
-- ─────────────────────────────────────────────────────────────────────────
-- H. Household invitations
-- ─────────────────────────────────────────────────────────────────────────
-- Mirrors wallet_invites (0009) one level up. wallet_invites is untouched:
-- an emailed wallet invite still means "join this wallet's household, and
-- get this one wallet directly", which is exactly what acceptance does.
create table space_invites (
  id            uuid primary key default gen_random_uuid(),
  space_id      uuid not null references spaces(id) on delete cascade,
  invited_email text not null check (length(btrim(invited_email)) between 3 and 320),
  invited_by    uuid not null references auth.users(id) on delete cascade,
  status        invite_status not null default 'pending',
  created_at    timestamptz not null default now(),
  responded_at  timestamptz
);
create unique index space_invites_one_pending
  on space_invites (space_id, lower(btrim(invited_email))) where status = 'pending';

alter table space_invites enable row level security;
revoke all on space_invites from anon, authenticated;
grant select on space_invites to authenticated;
-- Reads only; every write is a function below.
create policy space_invites_owner_select on space_invites
  for select to authenticated
  using (exists (select 1 from space_members sm
                  where sm.space_id = space_invites.space_id
                    and sm.user_id = auth.uid() and sm.role = 'owner'));
create policy space_invites_invitee_select on space_invites
  for select to authenticated
  using (lower(btrim(invited_email)) = lower(btrim(auth.jwt() ->> 'email')));

create function is_space_owner(s uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.space_members
                  where space_id = s and user_id = auth.uid() and role = 'owner')
$$;

create function invite_to_space(p_space uuid, p_email text) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  if not public.is_space_owner(p_space) then
    raise exception 'only the household owner can invite people';
  end if;
  if exists (select 1 from public.space_members sm
               join auth.users u on u.id = sm.user_id
              where sm.space_id = p_space and lower(u.email) = v_email) then
    raise exception 'that person is already in this household';
  end if;
  insert into public.space_invites (space_id, invited_email, invited_by)
  values (p_space, v_email, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create function revoke_space_invite(p_invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare v_space uuid;
begin
  select space_id into v_space from public.space_invites where id = p_invite and status = 'pending';
  if v_space is null or not public.is_space_owner(v_space) then
    raise exception 'that invitation is not yours to withdraw';
  end if;
  delete from public.space_invites where id = p_invite;
end $$;

create function accept_space_invite(p_invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  inv public.space_invites;
  caller_email text := lower(btrim(auth.jwt() ->> 'email'));
begin
  select * into inv from public.space_invites where id = p_invite for update;
  if inv is null or inv.status <> 'pending' then
    raise exception 'invite is not open';
  end if;
  if caller_email is null or lower(btrim(inv.invited_email)) <> caller_email then
    raise exception 'invite is addressed to someone else';
  end if;
  -- The join trigger (section E) grants every household-shared wallet.
  insert into public.space_members (space_id, user_id, role)
  values (inv.space_id, auth.uid(), 'member')
  on conflict (space_id, user_id) do nothing;
  update public.space_invites set status = 'accepted', responded_at = now() where id = p_invite;
end $$;

create function decline_space_invite(p_invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  inv public.space_invites;
  caller_email text := lower(btrim(auth.jwt() ->> 'email'));
begin
  select * into inv from public.space_invites where id = p_invite for update;
  if inv is null or inv.status <> 'pending' then
    raise exception 'invite is not open';
  end if;
  if caller_email is null or lower(btrim(inv.invited_email)) <> caller_email then
    raise exception 'invite is addressed to someone else';
  end if;
  update public.space_invites set status = 'declined', responded_at = now() where id = p_invite;
end $$;

create function get_pending_space_invites()
  returns table(id uuid, space_id uuid, space_name text, invited_by_name text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select si.id, si.space_id, s.name, p.display_name, si.created_at
    from public.space_invites si
    join public.spaces s on s.id = si.space_id
    left join public.profiles p on p.id = si.invited_by
   where si.status = 'pending'
     and lower(btrim(si.invited_email)) = lower(btrim(auth.jwt() ->> 'email'))
$$;

revoke all on function is_space_owner(uuid)              from public, anon;
revoke all on function invite_to_space(uuid, text)       from public, anon;
revoke all on function revoke_space_invite(uuid)         from public, anon;
revoke all on function accept_space_invite(uuid)         from public, anon;
revoke all on function decline_space_invite(uuid)        from public, anon;
revoke all on function get_pending_space_invites()       from public, anon;
grant execute on function is_space_owner(uuid)           to authenticated;
grant execute on function invite_to_space(uuid, text)    to authenticated;
grant execute on function revoke_space_invite(uuid)      to authenticated;
grant execute on function accept_space_invite(uuid)      to authenticated;
grant execute on function decline_space_invite(uuid)     to authenticated;
grant execute on function get_pending_space_invites()    to authenticated;
```

- [ ] **Step 4: Run the suites and regenerate types**

Run: `npm run test:rls && npm run test:constraints && npm run db:types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0025_household_sharing.sql supabase/tests/rls.sql src/lib/database.types.ts
git commit -m "feat: invite people to a household by email"
```

---

### Task 4: Leaving a household, and the sharing read

**Files:**
- Modify: `supabase/migrations/0025_household_sharing.sql` (append sections G, I)
- Create: `supabase/tests/leave_space.sql`, `scripts/test-leave-space.sh`
- Modify: `package.json` (script), `supabase/tests/rls.sql` (append)

**Interfaces:**
- Produces: `leave_space(p_space uuid) returns table(wallets_moved int, budgets_moved int, budgets_trimmed int)`; `remove_space_member(p_space uuid, p_user uuid)` same return; `get_wallet_sharing() returns table(wallet_id uuid, user_id uuid, via member_via)`.

- [ ] **Step 1: Write the failing fixture test**

Create `supabase/tests/leave_space.sql`:

```sql
-- supabase/tests/leave_space.sql
-- The "wallets go with them" routine, proved on a fixture. Run by
-- scripts/test-leave-space.sh on a freshly reset database.
--
--   owner  owns W_shared (household-shared) and W_own
--   mate   is in the household; owns M1 and M2 (both in the household)
--   M1 has: a txn on 'Groceries', a txn on a custom 'Bikes', a rule on 'Bikes'
--   M2 has: a txn with no category
--   budgets: B_mate over {M1, M2} on 'Bikes'; B_mixed over {W_shared, M1} (cap)
--   mate recorded one txn in W_shared
-- mate leaves. Then: mate's new household has the 16 defaults plus 'Bikes';
-- every moved row points at a category in the new household; B_mate moved
-- with its category repointed; B_mixed kept W_shared only; owner's data
-- untouched; mate can no longer read W_shared; mate's W_shared txn stays.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('c5c50000-0000-4000-8000-000000000001', 'ls-owner@x.io'),
  ('c5c50000-0000-4000-8000-000000000002', 'ls-mate@x.io');
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('c5c50000-0000-4000-8000-0000000000aa', 'c5c50000-0000-4000-8000-000000000001', 'W shared', 'bank', 'USD', 1, 'landmark'),
  ('c5c50000-0000-4000-8000-0000000000ab', 'c5c50000-0000-4000-8000-000000000001', 'W own',    'bank', 'USD', 2, 'wallet');
insert into space_members (space_id, user_id, role)
values ((select space_id from wallets where id = 'c5c50000-0000-4000-8000-0000000000aa'),
        'c5c50000-0000-4000-8000-000000000002', 'member');
begin;
  set local request.jwt.claims = '{"sub":"c5c50000-0000-4000-8000-000000000001"}';
  select set_wallet_sharing('c5c50000-0000-4000-8000-0000000000aa', true, array[]::uuid[]);
commit;
-- mate's wallets land in the shared household (set_wallet_space prefers the
-- most recently joined).
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('c5c50000-0000-4000-8000-0000000000b1', 'c5c50000-0000-4000-8000-000000000002', 'M1', 'bank', 'USD', 3, 'wallet'),
  ('c5c50000-0000-4000-8000-0000000000b2', 'c5c50000-0000-4000-8000-000000000002', 'M2', 'bank', 'USD', 4, 'wallet');
do $$ begin
  assert (select count(distinct space_id) from wallets where id in
    ('c5c50000-0000-4000-8000-0000000000aa','c5c50000-0000-4000-8000-0000000000b1','c5c50000-0000-4000-8000-0000000000b2')) = 1,
    'fixture broken: mate''s wallets are not in the shared household';
end $$;
insert into categories (id, space_id, name, kind, color_slot, icon)
values ('c5c50000-0000-4000-8000-0000000000c1',
        (select space_id from wallets where id = 'c5c50000-0000-4000-8000-0000000000aa'), 'Bikes', 'expense', 9, 'bike');
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on) values
  ('c5c50000-0000-4000-8000-0000000000t1', 'c5c50000-0000-4000-8000-0000000000b1', 'c5c50000-0000-4000-8000-000000000002', 'expense', -100, 'USD',
    (select id from categories where name = 'Groceries' and space_id = (select space_id from wallets where id = 'c5c50000-0000-4000-8000-0000000000aa')), current_date),
  ('c5c50000-0000-4000-8000-0000000000t2', 'c5c50000-0000-4000-8000-0000000000b1', 'c5c50000-0000-4000-8000-000000000002', 'expense', -200, 'USD',
    'c5c50000-0000-4000-8000-0000000000c1', current_date),
  ('c5c50000-0000-4000-8000-0000000000t3', 'c5c50000-0000-4000-8000-0000000000b2', 'c5c50000-0000-4000-8000-000000000002', 'expense', -300, 'USD',
    null, current_date),
  ('c5c50000-0000-4000-8000-0000000000t4', 'c5c50000-0000-4000-8000-0000000000aa', 'c5c50000-0000-4000-8000-000000000002', 'expense', -400, 'USD',
    'c5c50000-0000-4000-8000-0000000000c1', current_date);
insert into recurring_rules (id, wallet_id, created_by, name, kind, amount_minor, currency_code, category_id, interval_unit, anchor_on)
values ('c5c50000-0000-4000-8000-0000000000r1', 'c5c50000-0000-4000-8000-0000000000b1', 'c5c50000-0000-4000-8000-000000000002',
        'Tyres', 'expense', -50, 'USD', 'c5c50000-0000-4000-8000-0000000000c1', 'monthly', current_date);
begin;
  set local request.jwt.claims = '{"sub":"c5c50000-0000-4000-8000-000000000002"}';
  select set_budget('c5c50000-0000-4000-8000-0000000000c1', date_trunc('month', current_date)::date, 10000,
    array['c5c50000-0000-4000-8000-0000000000b1','c5c50000-0000-4000-8000-0000000000b2']::uuid[]);
  select set_budget(null, date_trunc('month', current_date)::date, 90000,
    array['c5c50000-0000-4000-8000-0000000000aa','c5c50000-0000-4000-8000-0000000000b1']::uuid[]);
commit;

-- >>> LEAVE
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"c5c50000-0000-4000-8000-000000000002","email":"ls-mate@x.io"}';
  select * from leave_space((select space_id from public.wallets where id = 'c5c50000-0000-4000-8000-0000000000b1'));
commit;

do $$
declare s_old uuid; s_new uuid; bikes_new uuid; b_mate uuid; b_mixed uuid;
begin
  select space_id into s_old from wallets where id = 'c5c50000-0000-4000-8000-0000000000aa';
  select space_id into s_new from wallets where id = 'c5c50000-0000-4000-8000-0000000000b1';
  assert s_new <> s_old, 'LEAVE BROKEN: M1 did not move to a new household';
  assert (select space_id from wallets where id = 'c5c50000-0000-4000-8000-0000000000b2') = s_new, 'LEAVE BROKEN: M2 did not move';
  assert (select role from space_members where space_id = s_new and user_id = 'c5c50000-0000-4000-8000-000000000002') = 'owner',
    'LEAVE BROKEN: mate does not own the new household';
  assert not exists (select 1 from space_members where space_id = s_old and user_id = 'c5c50000-0000-4000-8000-000000000002'),
    'LEAVE BROKEN: mate is still in the old household';

  -- Categories: defaults + Bikes, nothing else.
  assert (select count(*) from categories where space_id = s_new) = 17,
    format('LEAVE BROKEN: expected 17 categories in the new household, got %s', (select count(*) from categories where space_id = s_new));
  select id into bikes_new from categories where space_id = s_new and name = 'Bikes';
  assert bikes_new is not null and (select icon from categories where id = bikes_new) = 'bike', 'LEAVE BROKEN: Bikes was not copied with its icon';

  -- Every moved row points into the new household.
  assert (select count(*) from transactions t join categories c on c.id = t.category_id
           where t.wallet_id in ('c5c50000-0000-4000-8000-0000000000b1','c5c50000-0000-4000-8000-0000000000b2') and c.space_id <> s_new) = 0,
    'LEAVE BROKEN: a moved transaction still points at the old household''s category';
  assert (select space_id from transactions where id = 'c5c50000-0000-4000-8000-0000000000t3') = s_new, 'LEAVE BROKEN: the uncategorised txn did not move';
  assert (select category_id from transactions where id = 'c5c50000-0000-4000-8000-0000000000t2') = bikes_new, 'LEAVE BROKEN: t2 is not on the new Bikes';
  assert (select category_id from recurring_rules where id = 'c5c50000-0000-4000-8000-0000000000r1') = bikes_new
     and (select space_id from recurring_rules where id = 'c5c50000-0000-4000-8000-0000000000r1') = s_new, 'LEAVE BROKEN: the rule did not move';

  -- The txn mate recorded in W shared stays, attributed to mate.
  assert (select wallet_id from transactions where id = 'c5c50000-0000-4000-8000-0000000000t4') = 'c5c50000-0000-4000-8000-0000000000aa'
     and (select created_by from transactions where id = 'c5c50000-0000-4000-8000-0000000000t4') = 'c5c50000-0000-4000-8000-000000000002',
    'LEAVE BROKEN: mate''s transaction in the shared wallet was moved or re-attributed';

  -- Budgets.
  select b.id into b_mate from budgets b where b.amount_minor = 10000;
  select b.id into b_mixed from budgets b where b.amount_minor = 90000;
  assert (select space_id from budgets where id = b_mate) = s_new and (select category_id from budgets where id = b_mate) = bikes_new,
    'LEAVE BROKEN: the all-mate budget did not move with its category';
  assert (select count(*) from budget_wallets where budget_id = b_mate and space_id = s_new) = 2, 'LEAVE BROKEN: B_mate''s wallet links did not move';
  assert (select array_agg(wallet_id::text) from budget_wallets where budget_id = b_mixed) = array['c5c50000-0000-4000-8000-0000000000aa'],
    'LEAVE BROKEN: the mixed budget did not lose the moved wallet';
  assert (select space_id from budgets where id = b_mixed) = s_old, 'LEAVE BROKEN: the mixed budget moved';

  -- Membership.
  assert (select count(*) from wallet_members where wallet_id = 'c5c50000-0000-4000-8000-0000000000aa' and user_id = 'c5c50000-0000-4000-8000-000000000002') = 0,
    'LEAVE BROKEN: mate still has a row on the shared wallet';
  assert (select array_agg(via::text) from wallet_members where wallet_id = 'c5c50000-0000-4000-8000-0000000000b1') = array['owner'],
    'LEAVE BROKEN: M1 kept members other than its owner';
  assert (select shared_with_household from wallets where id = 'c5c50000-0000-4000-8000-0000000000b1') = false, 'LEAVE BROKEN: a moved wallet stayed household-shared';

  -- Owner's side untouched.
  assert (select count(*) from categories where space_id = s_old) = 17, 'LEAVE BROKEN: the old household''s categories changed';
  assert (select count(*) from wallets where space_id = s_old) = 2, 'LEAVE BROKEN: the old household''s wallet count changed';
end $$;

-- The owner cannot leave.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"c5c50000-0000-4000-8000-000000000001","email":"ls-owner@x.io"}';
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform public.leave_space((select space_id from public.wallets where id = 'c5c50000-0000-4000-8000-0000000000aa'));
      v_ok := true;
    exception when others then
      assert sqlerrm = 'the household owner cannot leave', format('wrong error: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: the household owner left their own household';
  end $$;
commit;

select 'leave_space tests passed' as result;
```

Create `scripts/test-leave-space.sh` (copy `scripts/test-seed.sh` and change the file it runs to `supabase/tests/leave_space.sql`; keep the loopback guard and the wait loop). `chmod +x` it. Add to `package.json` scripts: `"test:leave-space": "./scripts/test-leave-space.sh",` after `test:migration:0022`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:leave-space`
Expected: FAIL with `function leave_space(uuid) does not exist`.

- [ ] **Step 3: Append the migration sections**

```sql
-- ─────────────────────────────────────────────────────────────────────────
-- G. Leaving a household: your wallets come with you
-- ─────────────────────────────────────────────────────────────────────────
-- One transaction, keys deferred (section C). 0022's merge run in reverse
-- for one person: every category the moving rows reference is found or
-- created by (kind, lower(btrim(name))) in the new household, then rows
-- are repointed and moved. Budgets entirely over moving wallets move;
-- mixed ones lose the moving wallets (they keep at least one, so none
-- empties). Not granted directly: leave_space and remove_space_member
-- below are the two callers and carry the authorisation.
create function leave_space_impl(p_space uuid, p_user uuid)
  returns table(wallets_moved int, budgets_moved int, budgets_trimmed int)
  language plpgsql security definer set search_path = '' as $$
declare
  v_role          public.member_role;
  v_new           uuid;
  v_wallets       uuid[];
  v_moved_budgets uuid[];
  v_trimmed       int;
begin
  set constraints all deferred;

  select sm.role into v_role from public.space_members sm where sm.space_id = p_space and sm.user_id = p_user;
  if v_role is null then
    raise exception 'not a member of that household';
  end if;
  if v_role = 'owner' then
    raise exception 'the household owner cannot leave';
  end if;

  insert into public.spaces (name)
  values (left(coalesce((select nullif(btrim(p.display_name), '') from public.profiles p where p.id = p_user), 'My'), 49) || ' household')
  returning id into v_new;
  insert into public.space_members (space_id, user_id, role) values (v_new, p_user, 'owner');

  select coalesce(array_agg(w.id), array[]::uuid[]) into v_wallets
    from public.wallets w where w.owner_id = p_user and w.space_id = p_space;

  select coalesce(array_agg(b.id), array[]::uuid[]) into v_moved_budgets
    from public.budgets b
   where b.space_id = p_space
     and exists (select 1 from public.budget_wallets bw where bw.budget_id = b.id)
     and not exists (select 1 from public.budget_wallets bw
                      where bw.budget_id = b.id and not (bw.wallet_id = any(v_wallets)));

  -- Categories the moving rows need, created in the new household where no
  -- active same-named one exists (the seed trigger already made 16).
  insert into public.categories (space_id, name, kind, color_slot, icon, sort_order, is_default)
  select distinct on (c.kind, lower(btrim(c.name)))
         v_new, c.name, c.kind, c.color_slot, c.icon, 900, false
    from public.categories c
   where c.id in (
           select t.category_id from public.transactions t
            where t.wallet_id = any(v_wallets) and t.category_id is not null
           union
           select r.category_id from public.recurring_rules r where r.wallet_id = any(v_wallets)
           union
           select b.category_id from public.budgets b
            where b.id = any(v_moved_budgets) and b.category_id is not null)
     and not exists (select 1 from public.categories n
                      where n.space_id = v_new and n.kind = c.kind
                        and lower(btrim(n.name)) = lower(btrim(c.name)) and n.archived_at is null)
   order by c.kind, lower(btrim(c.name)), (c.archived_at is null) desc, c.created_at;

  update public.transactions t
     set category_id = n.id, space_id = v_new
    from public.categories o
    join public.categories n
      on n.space_id = v_new and n.kind = o.kind
     and lower(btrim(n.name)) = lower(btrim(o.name)) and n.archived_at is null
   where t.wallet_id = any(v_wallets) and t.category_id = o.id;
  update public.transactions set space_id = v_new
   where wallet_id = any(v_wallets) and category_id is null;

  update public.recurring_rules r
     set category_id = n.id, space_id = v_new
    from public.categories o
    join public.categories n
      on n.space_id = v_new and n.kind = o.kind
     and lower(btrim(n.name)) = lower(btrim(o.name)) and n.archived_at is null
   where r.wallet_id = any(v_wallets) and r.category_id = o.id;

  update public.budgets b
     set category_id = n.id, space_id = v_new
    from public.categories o
    join public.categories n
      on n.space_id = v_new and n.kind = o.kind
     and lower(btrim(n.name)) = lower(btrim(o.name)) and n.archived_at is null
   where b.id = any(v_moved_budgets) and b.category_id = o.id;
  update public.budgets set space_id = v_new
   where id = any(v_moved_budgets) and category_id is null;
  update public.budget_wallets set space_id = v_new where budget_id = any(v_moved_budgets);

  delete from public.budget_wallets bw
   where bw.wallet_id = any(v_wallets) and not (bw.budget_id = any(v_moved_budgets));
  get diagnostics v_trimmed = row_count;

  update public.wallets set space_id = v_new, shared_with_household = false where id = any(v_wallets);
  delete from public.wallet_members where wallet_id = any(v_wallets) and user_id <> p_user;
  update public.wallet_members set space_id = v_new where wallet_id = any(v_wallets) and user_id = p_user;

  -- Rows on wallets that stay behind; the cascade from space_members would
  -- take these too, but say it.
  delete from public.wallet_members m using public.wallets w
   where w.id = m.wallet_id and w.space_id = p_space and m.user_id = p_user;
  delete from public.space_members where space_id = p_space and user_id = p_user;

  return query select cardinality(v_wallets), cardinality(v_moved_budgets), v_trimmed;
end $$;

create function leave_space(p_space uuid)
  returns table(wallets_moved int, budgets_moved int, budgets_trimmed int)
  language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return query select * from public.leave_space_impl(p_space, auth.uid());
end $$;

create function remove_space_member(p_space uuid, p_user uuid)
  returns table(wallets_moved int, budgets_moved int, budgets_trimmed int)
  language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_space_owner(p_space) then
    raise exception 'only the household owner can remove people';
  end if;
  if p_user = auth.uid() then
    raise exception 'the household owner cannot leave';
  end if;
  return query select * from public.leave_space_impl(p_space, p_user);
end $$;

revoke all on function leave_space_impl(uuid, uuid)        from public, anon, authenticated;
revoke all on function leave_space(uuid)                   from public, anon;
revoke all on function remove_space_member(uuid, uuid)     from public, anon;
grant execute on function leave_space(uuid)                to authenticated;
grant execute on function remove_space_member(uuid, uuid)  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- I. The sharing grid's read
-- ─────────────────────────────────────────────────────────────────────────
-- wallet_members is already readable under members_select; this carries
-- `via` alongside in one call so the grid can be drawn from it plus
-- get_space_members (0024) for names.
create function get_wallet_sharing()
  returns table(wallet_id uuid, user_id uuid, via member_via)
  language sql stable security definer set search_path = '' as $$
  select m.wallet_id, m.user_id, m.via
    from public.wallet_members m
   where public.is_wallet_member(m.wallet_id)
$$;
revoke all on function get_wallet_sharing() from public, anon;
grant execute on function get_wallet_sharing() to authenticated;
```

- [ ] **Step 4: Run the fixture test**

Run: `npm run test:leave-space`
Expected: PASS. If it fails on a deferred-constraint message at `commit`, read which constraint: the ordering above satisfies every key at commit, so a failure there means a missed `space_id` update on one of the moved tables.

- [ ] **Step 5: Add the RLS removal test**

Append to `supabase/tests/rls.sql`:

```sql
-- =====================================================================
-- 0025: after remove_space_member, the removed user reads nothing of the
-- old household -- wallets, transactions, or category names.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000001","email":"hh-owner@x.io"}';
  select * from remove_space_member(
    (select space_id from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000a'),
    'b5b50000-0000-4000-8000-000000000003');
commit;
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000003","email":"hh-new@x.io"}';
  do $$ begin
    assert (select count(*) from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000a') = 0,
      'LEAK: a removed member can still see the household-shared wallet';
    assert (select count(*) from public.transactions where wallet_id = 'b5b50000-0000-4000-8000-00000000000a') = 0,
      'LEAK: a removed member can still read the household''s transactions';
    assert (select count(*) from public.categories where space_id =
             (select space_id from public.space_members where user_id = 'b5b50000-0000-4000-8000-000000000001' limit 1)) = 0,
      'LEAK: a removed member can still read the old household''s category names';
    assert (select count(*) from public.get_space_members() where user_id = 'b5b50000-0000-4000-8000-000000000003') = 1,
      'LEAVE BROKEN: the removed member does not own a household of their own';
  end $$;
commit;
-- A non-owner cannot remove anyone.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b5b50000-0000-4000-8000-000000000002","email":"hh-mate@x.io"}';
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform public.remove_space_member(
        (select space_id from public.wallets where id = 'b5b50000-0000-4000-8000-00000000000c'),
        'b5b50000-0000-4000-8000-000000000001');
      v_ok := true;
    exception when others then null;
    end;
    assert not v_ok, 'ESCALATION: a member removed the household owner';
  end $$;
commit;
```

- [ ] **Step 6: Run everything SQL, regenerate types**

Run: `npm run test:rls && npm run test:constraints && npm run test:seed && npm run test:leave-space && npm run test:migration:0022 && npm run db:types && npm run test:embeds`
Expected: all PASS. (`test:embeds` needs the stack settled; rerun once if it cannot read status.)

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0025_household_sharing.sql supabase/tests/ scripts/test-leave-space.sh package.json src/lib/database.types.ts
git commit -m "feat: leaving a household takes your wallets with you"
```

---

### Task 5: Server actions

**Files:**
- Create: `src/server/actions/household.ts`, `src/server/actions/household.test.ts`
- Modify: `src/server/actions/invites.ts` (`removeMember`), `src/server/actions/invites.test.ts`

**Interfaces:**
- Produces:
  - `setWalletSharing(walletId: string, householdShared: boolean, directUserIds: string[]): Promise<HouseholdState>`
  - `inviteToHousehold(spaceId: string, _prev: HouseholdState, formData: FormData): Promise<HouseholdState>` (bound form action)
  - `revokeHouseholdInvite(inviteId: string): Promise<HouseholdState>`
  - `respondToHouseholdInvite(inviteId: string, accept: boolean): Promise<HouseholdState>`
  - `leaveHousehold(spaceId: string): Promise<HouseholdState>`
  - `removeHouseholdMember(spaceId: string, userId: string): Promise<HouseholdState>`
  - `export type HouseholdState = { error?: string; notice?: string }`

- [ ] **Step 1: Write the failing tests**

Create `src/server/actions/household.test.ts`:

```ts
// src/server/actions/household.test.ts
//
// Same mocking shape as budgets.test.ts: `@/lib/supabase/server` and
// `next/cache` are intercepted before the module loads, so these tests run
// the actions' real validation and mapping without a request scope.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setWalletSharing,
  inviteToHousehold,
  revokeHouseholdInvite,
  respondToHouseholdInvite,
  leaveHousehold,
  removeHouseholdMember,
} from "./household";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INVITE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const { getUser, rpcCalls, rpcResult, revalidatePath } = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpcCalls: [] as { fn: string; args: unknown }[],
  rpcResult: { data: null as unknown, error: null as unknown },
  revalidatePath: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  rpcCalls.length = 0;
  rpcResult.data = null;
  rpcResult.error = null;
  getUser.mockResolvedValue({ data: { user: { id: USER, email: "me@x.io" } } });
});

const form = (email: string) => {
  const fd = new FormData();
  fd.set("email", email);
  return fd;
};

describe("setWalletSharing", () => {
  it("sends the whole row to set_wallet_sharing and revalidates both screens", async () => {
    const res = await setWalletSharing(WALLET, true, [MATE]);
    expect(res).toEqual({ notice: "Sharing updated." });
    expect(rpcCalls).toEqual([
      { fn: "set_wallet_sharing", args: { p_wallet: WALLET, p_household: true, p_direct: [MATE] } },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/wallets");
    expect(revalidatePath).toHaveBeenCalledWith("/household");
  });
  it("rejects a malformed user id before any RPC", async () => {
    const res = await setWalletSharing(WALLET, false, ["nope"]);
    expect(res).toEqual({ error: "That person is not valid." });
    expect(rpcCalls).toEqual([]);
  });
  it("maps the household-only refusal to app copy", async () => {
    rpcResult.error = { message: "a wallet can only be shared with people in its household" };
    const res = await setWalletSharing(WALLET, false, [MATE]);
    expect(res).toEqual({ error: "You can only share a wallet with people in its household." });
  });
  it("maps any other refusal to a generic message", async () => {
    rpcResult.error = { message: "only the wallet owner can change who it is shared with" };
    const res = await setWalletSharing(WALLET, false, []);
    expect(res).toEqual({ error: "Could not update sharing. Please try again." });
    expect(JSON.stringify(res)).not.toContain("wallet owner");
  });
});

describe("inviteToHousehold", () => {
  it("normalises the address, calls invite_to_space, and reports it", async () => {
    const res = await inviteToHousehold(SPACE, {}, form(" Pat@X.io "));
    expect(res).toEqual({ notice: "Invitation sent to pat@x.io." });
    expect(rpcCalls).toEqual([{ fn: "invite_to_space", args: { p_space: SPACE, p_email: "pat@x.io" } }]);
    expect(revalidatePath).toHaveBeenCalledWith("/household");
  });
  it("refuses an invalid address before any RPC", async () => {
    const res = await inviteToHousehold(SPACE, {}, form("not-an-email"));
    expect(res).toEqual({ error: "Enter a valid email address" });
    expect(rpcCalls).toEqual([]);
  });
  it("refuses inviting yourself", async () => {
    const res = await inviteToHousehold(SPACE, {}, form("me@x.io"));
    expect(res).toEqual({ error: "You are already in this household." });
    expect(rpcCalls).toEqual([]);
  });
  it("maps a duplicate pending invite (23505) to readable copy", async () => {
    rpcResult.error = { code: "23505", message: "duplicate key value" };
    const res = await inviteToHousehold(SPACE, {}, form("pat@x.io"));
    expect(res).toEqual({ error: "There is already a pending invitation to that address." });
  });
  it("maps the already-a-member refusal", async () => {
    rpcResult.error = { message: "that person is already in this household" };
    const res = await inviteToHousehold(SPACE, {}, form("pat@x.io"));
    expect(res).toEqual({ error: "That person is already in this household." });
  });
});

describe("revokeHouseholdInvite / respondToHouseholdInvite", () => {
  it("revokes through the RPC", async () => {
    expect(await revokeHouseholdInvite(INVITE)).toEqual({});
    expect(rpcCalls).toEqual([{ fn: "revoke_space_invite", args: { p_invite: INVITE } }]);
  });
  it("accepts and declines through the right RPCs and revalidates the layout", async () => {
    await respondToHouseholdInvite(INVITE, true);
    await respondToHouseholdInvite(INVITE, false);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["accept_space_invite", "decline_space_invite"]);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
  it("returns an error, never throws, on refusal", async () => {
    rpcResult.error = { message: "invite is addressed to someone else" };
    expect(await respondToHouseholdInvite(INVITE, true)).toEqual({ error: "Could not respond to that invitation." });
  });
});

describe("leaveHousehold / removeHouseholdMember", () => {
  it("leaves and reports what moved", async () => {
    rpcResult.data = [{ wallets_moved: 2, budgets_moved: 1, budgets_trimmed: 1 }];
    const res = await leaveHousehold(SPACE);
    expect(res).toEqual({ notice: "You left the household. 2 wallets and 1 budget went with you; 1 budget lost a wallet." });
    expect(rpcCalls).toEqual([{ fn: "leave_space", args: { p_space: SPACE } }]);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
  it("removes and reports in the third person", async () => {
    rpcResult.data = [{ wallets_moved: 0, budgets_moved: 0, budgets_trimmed: 0 }];
    const res = await removeHouseholdMember(SPACE, MATE);
    expect(res).toEqual({ notice: "Removed from the household. 0 wallets and 0 budgets went with them; 0 budgets lost a wallet." });
    expect(rpcCalls).toEqual([{ fn: "remove_space_member", args: { p_space: SPACE, p_user: MATE } }]);
  });
  it("maps the owner-cannot-leave refusal", async () => {
    rpcResult.error = { message: "the household owner cannot leave" };
    expect(await leaveHousehold(SPACE)).toEqual({ error: "The household owner cannot leave." });
  });
  it("rejects malformed ids before any RPC", async () => {
    expect(await removeHouseholdMember("x", MATE)).toEqual({ error: "That household no longer exists." });
    expect(rpcCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/actions/household`
Expected: FAIL, module `./household` not found.

- [ ] **Step 3: Write the actions**

Create `src/server/actions/household.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { inviteInput } from "@/lib/validation/invite";

export type HouseholdState = { error?: string; notice?: string };

/**
 * Household actions. Every write here is a SECURITY DEFINER RPC (0025)
 * whose own guards are the whole security boundary -- these functions
 * re-validate shape before the round trip and translate refusals into
 * app-authored copy, never forwarding the database's own message.
 */
const idSchema = z.uuid();
const idsSchema = z.array(z.uuid());

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export async function setWalletSharing(
  walletId: string,
  householdShared: boolean,
  directUserIds: string[],
): Promise<HouseholdState> {
  const wallet = idSchema.safeParse(walletId);
  if (!wallet.success) return { error: "That wallet no longer exists." };
  const direct = idsSchema.safeParse(directUserIds);
  if (!direct.success) return { error: "That person is not valid." };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase.rpc("set_wallet_sharing", {
    p_wallet: wallet.data,
    p_household: householdShared,
    p_direct: direct.data,
  });
  if (error) {
    if (error.message === "a wallet can only be shared with people in its household") {
      return { error: "You can only share a wallet with people in its household." };
    }
    return { error: "Could not update sharing. Please try again." };
  }
  revalidatePath("/wallets");
  revalidatePath("/household");
  return { notice: "Sharing updated." };
}

export async function inviteToHousehold(
  spaceId: string,
  _prev: HouseholdState,
  formData: FormData,
): Promise<HouseholdState> {
  const space = idSchema.safeParse(spaceId);
  if (!space.success) return { error: "That household no longer exists." };
  const parsed = inviteInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  if (parsed.data.email === (user.email ?? "").toLowerCase()) {
    return { error: "You are already in this household." };
  }

  const { error } = await supabase.rpc("invite_to_space", { p_space: space.data, p_email: parsed.data.email });
  if (error) {
    if (error.code === "23505") return { error: "There is already a pending invitation to that address." };
    if (error.message === "that person is already in this household") {
      return { error: "That person is already in this household." };
    }
    return { error: "Could not send that invitation. Please try again." };
  }
  revalidatePath("/household");
  return { notice: `Invitation sent to ${parsed.data.email}.` };
}

export async function revokeHouseholdInvite(inviteId: string): Promise<HouseholdState> {
  const id = idSchema.safeParse(inviteId);
  if (!id.success) return { error: "That invitation is no longer pending." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  const { error } = await supabase.rpc("revoke_space_invite", { p_invite: id.data });
  if (error) return { error: "Could not withdraw that invitation. Please try again." };
  revalidatePath("/household");
  return {};
}

export async function respondToHouseholdInvite(inviteId: string, accept: boolean): Promise<HouseholdState> {
  const id = idSchema.safeParse(inviteId);
  if (!id.success) return { error: "That invitation is no longer pending." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  const { error } = await supabase.rpc(accept ? "accept_space_invite" : "decline_space_invite", {
    p_invite: id.data,
  });
  if (error) return { error: "Could not respond to that invitation." };
  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  revalidatePath("/household");
  return {};
}

type LeaveSummary = { wallets_moved: number; budgets_moved: number; budgets_trimmed: number };

function summarise(rows: LeaveSummary[] | null, who: "you" | "them"): string {
  const s = rows?.[0] ?? { wallets_moved: 0, budgets_moved: 0, budgets_trimmed: 0 };
  return `${plural(s.wallets_moved, "wallet", "wallets")} and ${plural(s.budgets_moved, "budget", "budgets")} went with ${who}; ${plural(s.budgets_trimmed, "budget", "budgets")} lost a wallet.`;
}

export async function leaveHousehold(spaceId: string): Promise<HouseholdState> {
  const space = idSchema.safeParse(spaceId);
  if (!space.success) return { error: "That household no longer exists." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  const { data, error } = await supabase.rpc("leave_space", { p_space: space.data });
  if (error) {
    if (error.message === "the household owner cannot leave") return { error: "The household owner cannot leave." };
    return { error: "Could not leave the household. Please try again." };
  }
  revalidatePath("/", "layout");
  return { notice: `You left the household. ${summarise(data as LeaveSummary[] | null, "you")}` };
}

export async function removeHouseholdMember(spaceId: string, userId: string): Promise<HouseholdState> {
  const space = idSchema.safeParse(spaceId);
  if (!space.success) return { error: "That household no longer exists." };
  const target = idSchema.safeParse(userId);
  if (!target.success) return { error: "That person is not in this household." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  const { data, error } = await supabase.rpc("remove_space_member", { p_space: space.data, p_user: target.data });
  if (error) return { error: "Could not remove that person. Please try again." };
  revalidatePath("/", "layout");
  return { notice: `Removed from the household. ${summarise(data as LeaveSummary[] | null, "them")}` };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/server/actions/household`
Expected: PASS.

- [ ] **Step 5: Rewrite `removeMember` onto `set_wallet_sharing`**

In `src/server/actions/invites.ts`, replace the body of `removeMember` after the `wallet` lookup and owner checks with:

```ts
  // wallet_members is no longer writable directly (0025). Removing one
  // person is "the same sharing, minus them": read the wallet's current
  // direct list and household flag, and submit the row without them. A
  // member who is here via the household cannot be removed one at a time
  // -- that is what "shared with the household" means -- so say so.
  const [{ data: rows }, { data: w }] = await Promise.all([
    supabase.from("wallet_members").select("user_id, via").eq("wallet_id", walletId),
    supabase.from("wallets").select("shared_with_household").eq("id", walletId).maybeSingle(),
  ]);
  const target = (rows ?? []).find((r) => r.user_id === userId);
  if (!target) return { error: "That person is not in this wallet." };
  if (target.via === "household") {
    return { error: "They see this wallet because it is shared with the household. Turn that off to remove them." };
  }
  const direct = (rows ?? []).filter((r) => r.via === "direct" && r.user_id !== userId).map((r) => r.user_id);
  const { error } = await supabase.rpc("set_wallet_sharing", {
    p_wallet: walletId,
    p_household: w?.shared_with_household ?? false,
    p_direct: direct,
  });
  if (error) return { error: "Could not remove that person. Please try again." };
  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  revalidatePath("/household");
  return {};
```

Update `src/server/actions/invites.test.ts`: the `wallet_members` fake needs `select().eq()` returning rows shaped `{ user_id, via }` and no longer a `delete`; the `wallets` fake needs `shared_with_household`. Assert that `removeMember` calls `set_wallet_sharing` with the remaining direct ids, and that a `via: "household"` target returns the household message with no RPC.

- [ ] **Step 6: Run the actions suite and typecheck**

Run: `npx vitest run src/server/actions && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/actions/household.ts src/server/actions/household.test.ts src/server/actions/invites.ts src/server/actions/invites.test.ts
git commit -m "feat: household server actions, and removeMember goes through set_wallet_sharing"
```

---

### Task 6: `WalletSharingRow`

**Files:**
- Create: `src/components/WalletSharingRow.tsx`, `src/components/WalletSharingRow.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type SharingMember = { user_id: string; display_name: string; via: "owner" | "household" | "direct" | null };
  export function WalletSharingRow(props: {
    walletId: string;
    walletName: string;
    householdShared: boolean;
    /** Every household member except the owner, with their current access (null = none). */
    members: SharingMember[];
    canEdit: boolean;
  }): JSX.Element
  ```
  Calls `setWalletSharing` from Task 5 on Save.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/WalletSharingRow.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletSharingRow } from "./WalletSharingRow";
import { setWalletSharing } from "@/server/actions/household";

vi.mock("@/server/actions/household", () => ({ setWalletSharing: vi.fn() }));

const members = [
  { user_id: "u-bob", display_name: "bob", via: "household" as const },
  { user_id: "u-cat", display_name: "cat", via: "direct" as const },
  { user_id: "u-dan", display_name: "dan", via: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setWalletSharing).mockResolvedValue({ notice: "Sharing updated." });
});

describe("WalletSharingRow", () => {
  it("shows each member's access and the household switch state", () => {
    render(<WalletSharingRow walletId="w1" walletName="Everyday" householdShared members={members} canEdit />);
    expect(screen.getByRole("switch", { name: "Share Everyday with the whole household" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Share Everyday directly with bob" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Share Everyday directly with cat" })).toBeChecked();
    expect(screen.getByText("bob · via household")).toBeInTheDocument();
    expect(screen.getByText("cat · direct")).toBeInTheDocument();
    expect(screen.getByText("dan · no access")).toBeInTheDocument();
  });

  it("submits the whole row: switch off, direct list as checked", async () => {
    const user = userEvent.setup();
    render(<WalletSharingRow walletId="w1" walletName="Everyday" householdShared members={members} canEdit />);
    await user.click(screen.getByRole("switch", { name: "Share Everyday with the whole household" }));
    await user.click(screen.getByRole("checkbox", { name: "Share Everyday directly with dan" }));
    await user.click(screen.getByRole("button", { name: "Save sharing for Everyday" }));
    expect(setWalletSharing).toHaveBeenCalledWith("w1", false, ["u-cat", "u-dan"]);
    expect(await screen.findByText("Sharing updated.")).toBeInTheDocument();
  });

  it("is read-only when the viewer does not own the wallet", () => {
    render(<WalletSharingRow walletId="w1" walletName="Everyday" householdShared={false} members={members} canEdit={false} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save sharing/ })).not.toBeInTheDocument();
    expect(screen.getByText("Only the wallet's owner can change this.")).toBeInTheDocument();
  });

  it("surfaces an action error in the status line", async () => {
    vi.mocked(setWalletSharing).mockResolvedValue({ error: "Could not update sharing. Please try again." });
    const user = userEvent.setup();
    render(<WalletSharingRow walletId="w1" walletName="Everyday" householdShared={false} members={members} canEdit />);
    await user.click(screen.getByRole("button", { name: "Save sharing for Everyday" }));
    expect(await screen.findByText("Could not update sharing. Please try again.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/WalletSharingRow`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the component**

```tsx
// src/components/WalletSharingRow.tsx
"use client";

import { useId, useState, useTransition } from "react";
import { setWalletSharing } from "@/server/actions/household";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type SharingMember = {
  user_id: string;
  display_name: string;
  via: "owner" | "household" | "direct" | null;
};

/**
 * One wallet's sharing, rendered the same way on /household (one row of the
 * grid) and /wallets (under the wallet). The switch shares with everyone in
 * the household; a checkbox is a DIRECT share that survives turning the
 * switch off later (set_wallet_sharing, 0025: direct outranks household).
 * Save submits the whole row, so what you see is exactly what is stored.
 */
export function WalletSharingRow({
  walletId,
  walletName,
  householdShared,
  members,
  canEdit,
}: {
  walletId: string;
  walletName: string;
  householdShared: boolean;
  members: SharingMember[];
  canEdit: boolean;
}) {
  const [household, setHousehold] = useState(householdShared);
  const [direct, setDirect] = useState<Set<string>>(
    () => new Set(members.filter((m) => m.via === "direct").map((m) => m.user_id)),
  );
  const [status, setStatus] = useState<{ error?: string; notice?: string }>({});
  const [saving, start] = useTransition();
  const statusId = useId();

  function label(m: SharingMember) {
    if (m.via === "household") return `${m.display_name} · via household`;
    if (m.via === "direct") return `${m.display_name} · direct`;
    return `${m.display_name} · no access`;
  }

  function save() {
    setStatus({});
    start(async () => {
      const res = await setWalletSharing(walletId, household, [...direct]);
      setStatus(res);
    });
  }

  return (
    <div className="flex flex-col gap-2" aria-describedby={statusId}>
      {canEdit ? (
        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--ink)" }}>
          <input
            type="checkbox"
            role="switch"
            aria-label={`Share ${walletName} with the whole household`}
            checked={household}
            onChange={(e) => setHousehold(e.target.checked)}
          />
          Share with the whole household
        </label>
      ) : (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          {householdShared ? "Shared with the whole household." : "Not shared with the household."}{" "}
          Only the wallet&apos;s owner can change this.
        </p>
      )}
      <ul className="flex flex-col gap-1" aria-label={`${walletName} access`}>
        {members.map((m) => (
          <li key={m.user_id} className="flex items-center gap-2 text-sm" style={{ color: "var(--ink)" }}>
            {canEdit && (
              <input
                type="checkbox"
                aria-label={`Share ${walletName} directly with ${m.display_name}`}
                checked={direct.has(m.user_id)}
                onChange={(e) => {
                  const next = new Set(direct);
                  if (e.target.checked) next.add(m.user_id);
                  else next.delete(m.user_id);
                  setDirect(next);
                }}
              />
            )}
            <span>{label(m)}</span>
          </li>
        ))}
      </ul>
      {canEdit && (
        <button
          type="button"
          onClick={save}
          disabled={saving}
          aria-label={`Save sharing for ${walletName}`}
          className={`self-start rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      )}
      {/* Always mounted: a live region that appears with its text is not
          reliably announced (WalletList's own alert paragraph). */}
      <p id={statusId} role="status" className="text-sm" style={{ color: status.error ? "var(--neg)" : "var(--ink-2)" }}>
        {status.error ?? status.notice}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/WalletSharingRow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/WalletSharingRow.tsx src/components/WalletSharingRow.test.tsx
git commit -m "feat: one control for a wallet's sharing"
```

---

### Task 7: The household screen

**Files:**
- Create: `src/components/InviteByEmailForm.tsx`
- Create: `src/app/(app)/household/HouseholdSection.tsx`, `src/app/(app)/household/HouseholdSection.test.tsx`
- Modify: `src/app/(app)/household/page.tsx`, `src/app/(app)/household/page.test.tsx`
- Modify: `src/app/(app)/wallets/MembersSection.tsx` (use `InviteByEmailForm`)

**Interfaces:**
- Consumes: `WalletSharingRow`, `SharingMember` (Task 6); actions from Task 5; RPCs `get_space_members` (0024), `get_wallet_sharing` (Task 4).
- Produces:
  ```ts
  // InviteByEmailForm
  export function InviteByEmailForm(props: {
    action: (prev: { error?: string; notice?: string }, formData: FormData) => Promise<{ error?: string; notice?: string }>;
    label?: string; // default "Invite by email"
  }): JSX.Element
  // HouseholdSection
  export type HouseholdMember = { user_id: string; display_name: string; role: "owner" | "member" };
  export type HouseholdWallet = { id: string; name: string; owner_id: string; shared_with_household: boolean; archived_at: string | null };
  export type HouseholdInvite = { id: string; invited_email: string };
  export function HouseholdSection(props: {
    space: { id: string; name: string };
    currentUserId: string;
    members: HouseholdMember[];
    wallets: HouseholdWallet[];
    /** (wallet_id, user_id) -> via, from get_wallet_sharing */
    access: { wallet_id: string; user_id: string; via: "owner" | "household" | "direct" }[];
    pendingInvites: HouseholdInvite[];
    single: boolean;
  }): JSX.Element
  ```

- [ ] **Step 1: Lift the invite form**

Create `src/components/InviteByEmailForm.tsx` with the `<form action={inviteAction}>` block from `MembersSection.tsx` (the `Invite by email` label, email input, `Send invitation` button, and the `role="status"` paragraph), taking `action` and running `useActionState(action, {})` inside. Replace that block in `MembersSection.tsx` with `<InviteByEmailForm action={inviteToWallet.bind(null, walletId)} />`. Run `npx vitest run "src/app/(app)/wallets"` — expected PASS with no test changes (same markup, same accessible names).

- [ ] **Step 2: Write the failing section test**

```tsx
// src/app/(app)/household/HouseholdSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HouseholdSection } from "./HouseholdSection";
import { leaveHousehold, removeHouseholdMember } from "@/server/actions/household";

vi.mock("@/server/actions/household", () => ({
  leaveHousehold: vi.fn(),
  removeHouseholdMember: vi.fn(),
  revokeHouseholdInvite: vi.fn(),
  inviteToHousehold: vi.fn(),
  setWalletSharing: vi.fn(),
}));

const space = { id: "s1", name: "alice household" };
const members = [
  { user_id: "u-alice", display_name: "alice", role: "owner" as const },
  { user_id: "u-bob", display_name: "bob", role: "member" as const },
];
const wallets = [
  { id: "w1", name: "Everyday", owner_id: "u-alice", shared_with_household: true, archived_at: null },
  { id: "w2", name: "Bob private", owner_id: "u-bob", shared_with_household: false, archived_at: null },
];
const access = [
  { wallet_id: "w1", user_id: "u-alice", via: "owner" as const },
  { wallet_id: "w1", user_id: "u-bob", via: "household" as const },
  { wallet_id: "w2", user_id: "u-bob", via: "owner" as const },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(leaveHousehold).mockResolvedValue({ notice: "You left the household." });
  vi.mocked(removeHouseholdMember).mockResolvedValue({ notice: "Removed from the household." });
});

describe("HouseholdSection as the owner", () => {
  const props = { space, currentUserId: "u-alice", members, wallets, access, pendingInvites: [{ id: "i1", invited_email: "pat@x.io" }], single: true };

  it("offers invite, revoke and remove, but never remove on themselves", () => {
    render(<HouseholdSection {...props} />);
    expect(screen.getByLabelText("Invite by email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke invitation to pat@x.io" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove bob from the household" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove alice from the household" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave household" })).not.toBeInTheDocument();
  });

  it("asks before removing, and says what goes with them", async () => {
    const user = userEvent.setup();
    render(<HouseholdSection {...props} />);
    await user.click(screen.getByRole("button", { name: "Remove bob from the household" }));
    const dialog = screen.getByRole("dialog", { name: "Remove bob?" });
    expect(dialog).toHaveTextContent("Wallets bob owns go with them into a new household");
    expect(removeHouseholdMember).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(removeHouseholdMember).toHaveBeenCalledWith("s1", "u-bob");
    expect(await screen.findByText("Removed from the household.")).toBeInTheDocument();
  });

  it("renders the sharing grid with editable rows only for wallets the viewer owns", () => {
    render(<HouseholdSection {...props} />);
    const grid = screen.getByRole("table", { name: "Who can see which wallet" });
    expect(within(grid).getByRole("switch", { name: "Share Everyday with the whole household" })).toBeChecked();
    expect(within(grid).queryByRole("switch", { name: "Share Bob private with the whole household" })).not.toBeInTheDocument();
    expect(within(grid).getByText("bob · via household")).toBeInTheDocument();
  });
});

describe("HouseholdSection as a member", () => {
  const props = { space, currentUserId: "u-bob", members, wallets, access, pendingInvites: [], single: true };

  it("offers Leave with a confirm, and no owner controls", async () => {
    const user = userEvent.setup();
    render(<HouseholdSection {...props} />);
    expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove .* from the household/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Leave household" }));
    const dialog = screen.getByRole("dialog", { name: "Leave alice household?" });
    expect(dialog).toHaveTextContent("Wallets you own go with you into a new household");
    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    expect(leaveHousehold).toHaveBeenCalledWith("s1");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run "src/app/(app)/household/HouseholdSection"`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `HouseholdSection`**

```tsx
// src/app/(app)/household/HouseholdSection.tsx
"use client";

import { useId, useState, useTransition } from "react";
import {
  inviteToHousehold,
  leaveHousehold,
  removeHouseholdMember,
  revokeHouseholdInvite,
} from "@/server/actions/household";
import { InviteByEmailForm } from "@/components/InviteByEmailForm";
import { WalletSharingRow, type SharingMember } from "@/components/WalletSharingRow";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type HouseholdMember = { user_id: string; display_name: string; role: "owner" | "member" };
export type HouseholdWallet = {
  id: string; name: string; owner_id: string; shared_with_household: boolean; archived_at: string | null;
};
export type HouseholdInvite = { id: string; invited_email: string };
type Access = { wallet_id: string; user_id: string; via: "owner" | "household" | "direct" };

/**
 * One household: members, invitations, leave/remove, and the sharing grid.
 * Membership is managed by the household OWNER; each wallet's sharing by
 * that wallet's OWNER (WalletSharingRow's `canEdit`). Leave and Remove both
 * open an in-page confirm (role="dialog", not window.confirm: the app's own
 * dialogs are what its tests and screen-reader users already handle) that
 * states what moves with the person before anything is sent.
 */
export function HouseholdSection({
  space, currentUserId, members, wallets, access, pendingInvites, single,
}: {
  space: { id: string; name: string };
  currentUserId: string;
  members: HouseholdMember[];
  wallets: HouseholdWallet[];
  access: Access[];
  pendingInvites: HouseholdInvite[];
  single: boolean;
}) {
  const isOwner = members.some((m) => m.user_id === currentUserId && m.role === "owner");
  const headingId = useId();
  const [confirm, setConfirm] = useState<{ kind: "leave" } | { kind: "remove"; member: HouseholdMember } | null>(null);
  const [status, setStatus] = useState<{ error?: string; notice?: string }>({});
  const [busy, start] = useTransition();

  function runConfirm() {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    setStatus({});
    start(async () => {
      const res = target.kind === "leave"
        ? await leaveHousehold(space.id)
        : await removeHouseholdMember(space.id, target.member.user_id);
      setStatus(res);
    });
  }

  function revoke(id: string) {
    setStatus({});
    start(async () => {
      const res = await revokeHouseholdInvite(id);
      setStatus(res);
    });
  }

  const sorted = members.slice().sort((a, b) =>
    a.role === b.role ? a.display_name.localeCompare(b.display_name) : a.role === "owner" ? -1 : 1,
  );
  const viaFor = (walletId: string, userId: string) =>
    access.find((a) => a.wallet_id === walletId && a.user_id === userId)?.via ?? null;

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className={single ? "mb-4 text-lg font-semibold" : "mb-4 text-xl font-semibold"} style={{ color: "var(--ink)" }}>
        {space.name}
      </h2>

      <p role="status" className="mb-3 text-sm" style={{ color: status.error ? "var(--neg)" : "var(--ink-2)" }}>
        {status.error ?? status.notice}
      </p>

      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>Members</h3>
      <ul className="mb-4 flex flex-col gap-2" aria-label={`${space.name} members`}>
        {sorted.map((m) => (
          <li key={m.user_id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--grid)", background: "var(--surface)", color: "var(--ink)" }}>
            <span>
              {m.display_name}
              {m.user_id === currentUserId && <span className="ml-2 text-xs" style={{ color: "var(--ink-2)" }}>(you)</span>}
            </span>
            <span className="flex items-center gap-3 text-xs" style={{ color: "var(--ink-2)" }}>
              {m.role === "owner" ? "Owner" : "Member"}
              {isOwner && m.user_id !== currentUserId && (
                <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "remove", member: m })}
                        aria-label={`Remove ${m.display_name} from the household`}
                        className={`underline disabled:opacity-60 ${FOCUS_RING}`}>
                  Remove
                </button>
              )}
            </span>
          </li>
        ))}
        {isOwner && pendingInvites.map((inv) => (
          <li key={inv.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--grid)", color: "var(--ink-2)" }}>
            <span>{inv.invited_email}</span>
            <span className="flex items-center gap-3 text-xs">
              Pending
              <button type="button" disabled={busy} onClick={() => revoke(inv.id)}
                      aria-label={`Revoke invitation to ${inv.invited_email}`}
                      className={`underline disabled:opacity-60 ${FOCUS_RING}`}>
                Revoke
              </button>
            </span>
          </li>
        ))}
      </ul>

      {isOwner ? (
        <div className="mb-6"><InviteByEmailForm action={inviteToHousehold.bind(null, space.id)} /></div>
      ) : (
        <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "leave" })}
                className={`mb-6 rounded-md border px-3 py-1.5 text-sm ${FOCUS_RING}`}
                style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}>
          Leave household
        </button>
      )}

      {confirm && (
        <div role="dialog" aria-modal="true"
             aria-label={confirm.kind === "leave" ? `Leave ${space.name}?` : `Remove ${confirm.member.display_name}?`}
             className="mb-6 rounded-lg border p-4" style={{ borderColor: "var(--neg)", background: "var(--surface)" }}>
          <p className="mb-3 text-sm" style={{ color: "var(--ink)" }}>
            {confirm.kind === "leave"
              ? "Wallets you own go with you into a new household, with the categories they use. Budgets over your wallets alone go too; budgets shared with others lose your wallets. Transactions you recorded in shared wallets stay here."
              : `Wallets ${confirm.member.display_name} owns go with them into a new household, with the categories they use. Budgets over their wallets alone go too; budgets shared with others lose their wallets. Transactions they recorded in shared wallets stay here.`}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={runConfirm} className={`rounded-md px-3 py-1.5 text-sm font-medium ${FOCUS_RING}`}
                    style={{ background: "var(--neg)", color: "var(--surface)" }}>
              {confirm.kind === "leave" ? "Leave" : "Remove"}
            </button>
            <button type="button" onClick={() => setConfirm(null)} className={`text-sm underline ${FOCUS_RING}`} style={{ color: "var(--ink-2)" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>Who can see which wallet</h3>
      <div className="overflow-x-auto">
        <table aria-label="Who can see which wallet" className="w-full text-sm" style={{ color: "var(--ink)" }}>
          <thead>
            <tr>
              <th scope="col" className="py-1 text-left font-medium">Wallet</th>
              <th scope="col" className="py-1 text-left font-medium">Sharing</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w) => {
              const others: SharingMember[] = sorted
                .filter((m) => m.user_id !== w.owner_id)
                .map((m) => ({ user_id: m.user_id, display_name: m.display_name, via: viaFor(w.id, m.user_id) }));
              const ownerName = members.find((m) => m.user_id === w.owner_id)?.display_name ?? "someone";
              return (
                <tr key={w.id} className="border-t align-top" style={{ borderColor: "var(--grid)" }}>
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    {w.name}
                    <span className="block text-xs font-normal" style={{ color: "var(--ink-2)" }}>
                      {w.owner_id === currentUserId ? "yours" : `${ownerName}'s`}{w.archived_at ? " · archived" : ""}
                    </span>
                  </th>
                  <td className="py-2">
                    <WalletSharingRow walletId={w.id} walletName={w.name} householdShared={w.shared_with_household}
                                      members={others} canEdit={w.owner_id === currentUserId} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run "src/app/(app)/household/HouseholdSection"`
Expected: PASS.

- [ ] **Step 6: Wire the page**

Replace the body of `src/app/(app)/household/page.tsx` so it loads, in one `Promise.all`:

```ts
supabase.from("spaces").select("id, name").order("created_at"),
supabase.rpc("get_space_members"),
supabase.from("wallets").select("id, name, owner_id, shared_with_household, archived_at, space_id").order("created_at"),
supabase.rpc("get_wallet_sharing"),
supabase.from("space_invites").select("id, space_id, invited_email").eq("status", "pending"),
```

throws on any error with the existing messages plus `"Failed to load sharing"` and `"Failed to load invitations"`, redirects to `/onboarding` on no spaces, and renders the intro paragraph ("Everyone in a household shares one list of categories. The household owner invites people here; each wallet's owner chooses who sees it.") followed by one `<HouseholdSection>` per space with `members`, `wallets`, `access`, and `pendingInvites` filtered by `space_id`, `currentUserId={profile.id}`, `single={spaces.length === 1}`. Update `page.test.tsx`: the mock `from` must also answer `space_invites` (`select().eq()` thenable) and `rpc` must answer `get_wallet_sharing` with `[]`; the existing three tests keep their assertions, since the members list and wallet list keep their accessible names (`<name> members`; the wallets are now rows of the grid, so change the wallets assertions to look up `screen.getByRole("row", { name: /Old card/ })` and assert it has text "archived").

- [ ] **Step 7: Run page tests, typecheck, lint**

Run: `npx vitest run "src/app/(app)/household" && npx tsc --noEmit && npx eslint`
Expected: PASS, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/InviteByEmailForm.tsx "src/app/(app)/household" "src/app/(app)/wallets/MembersSection.tsx"
git commit -m "feat: manage the household from its own screen"
```

---

### Task 8: `/wallets` uses the same control and lists household invitations

**Files:**
- Modify: `src/app/(app)/wallets/MembersSection.tsx`, `MembersSection.test.tsx`
- Modify: `src/app/(app)/wallets/PendingInvites.tsx`
- Modify: `src/app/(app)/wallets/page.tsx`

**Interfaces:**
- Consumes: `WalletSharingRow`, `respondToHouseholdInvite`, RPCs `get_wallet_sharing`, `get_pending_space_invites`, `get_space_members`.
- Produces: `MembersSection` gains props `householdShared: boolean` and `householdMembers: SharingMember[]` (every household member except the owner, with `via`); `PendingInvite` becomes `{ id: string; kind: "wallet" | "household"; name: string }`.

- [ ] **Step 1: Update the MembersSection tests**

In `MembersSection.test.tsx`: for the owner case, assert the `switch` named `Share <wallet> with the whole household` and one checkbox per household member replace the per-person "Remove" buttons; for the non-owner case, assert the read-only sentence. Keep the invite-form and pending-invite assertions. Run — expected FAIL on the missing switch.

- [ ] **Step 2: Change MembersSection**

Render the members list as today (name + Owner tag, no Remove buttons), then `<WalletSharingRow walletId={walletId} walletName={walletName} householdShared={householdShared} members={householdMembers} canEdit={isOwner} />` (add a `walletName: string` prop), then pending invitees and the invite form. Delete the `remove` transition and its imports. Run tests — expected PASS.

- [ ] **Step 3: PendingInvites for both kinds**

Change the prop type to `{ id: string; kind: "wallet" | "household"; name: string }`. Render the label as `Join wallet ${name}` or `Join ${name}` (household names already end in "household"). `respond` calls `respondToInvite` for `wallet` and `respondToHouseholdInvite` for `household`. When any household invite is present, render a `<Link href="/household">` "Manage households" under the list. Update `page.tsx`'s `pendingInvites` construction to map `get_pending_invites` rows to `kind: "wallet", name: wallet_name` and `get_pending_space_invites` rows to `kind: "household", name: space_name`.

- [ ] **Step 4: Page data**

In `wallets/page.tsx` add to the `Promise.all`: `supabase.rpc("get_pending_space_invites")`, `supabase.rpc("get_wallet_sharing")`, `supabase.rpc("get_space_members")`, and change the wallets select to include `space_id, shared_with_household`. Build `householdMembersByWalletId`: for each wallet, every `get_space_members` row with the wallet's `space_id` except its owner, with `via` looked up from `get_wallet_sharing` (null if absent). Pass `walletName`, `householdShared`, `householdMembers` into each `MembersSection`.

- [ ] **Step 5: Verify**

Run: `npx vitest run "src/app/(app)/wallets" && npx tsc --noEmit && npm run test:embeds`
Expected: PASS. (`test:embeds` needs the local stack up; it also checks the wallets page's `select` strings still resolve.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/wallets"
git commit -m "feat: the wallets screen shares through the same control, and lists household invitations"
```

---

### Task 9: End to end, and closing out

**Files:**
- Modify: `e2e/sharing.spec.ts`
- Modify: `docs/superpowers/specs/2026-09-06-household-sharing-design.md` (status + departures)

- [ ] **Step 1: Add the e2e path**

Append to `e2e/sharing.spec.ts` a test `"a household owner invites, shares, and a member leaves"`:

1. A signs up and onboards into wallet "Shared"; adds wallet "Private" via `addWallet`.
2. A goes to `/household`, fills `Invite by email` with B's address (B signs up first in its own context with wallet "Bs own"), clicks `Send invitation`, expects `Invitation sent to <b>`.
3. B goes to `/wallets`, expects `getByLabel("Pending invitations").getByText(/Join .* household/)`, clicks `Accept`, expects the Accept button count 0.
4. A on `/household`: in the row `getByRole("row", { name: /Shared/ })`, clicks the switch `Share Shared with the whole household`, clicks `Save sharing for Shared`, expects `Sharing updated.`.
5. B on `/wallets`: expects `getByText("Shared")` visible and `getByText("Private")` count 0.
6. A shares "Private" directly: checkbox `Share Private directly with <bName>`, Save. B reloads `/wallets`, expects "Private" visible.
7. B on `/household` clicks `Leave household`, then `Leave` in the dialog; expects text `You left the household.`. B on `/wallets` expects "Shared" count 0 and "Bs own" visible. A on `/wallets` still sees "Shared" and "Private".

Reuse `signUpAndOnboard`, `addWallet`, `displayNameOf` from the file.

- [ ] **Step 2: Run the whole verification set**

Run, with the local stack up:

```bash
npm run test:constraints && npm run test:rls && npm run test:seed && npm run test:leave-space && npm run test:migration:0022 && npm run test:embeds && npm test && npx tsc --noEmit && npx eslint && npx playwright test
```

Expected: every suite passes. Fix anything that fails in the task that owns it before moving on.

- [ ] **Step 3: Spec bookkeeping**

In the spec, set `**Status:**` to `Implemented on feat/household-sharing (<date>)` and add a `## 11. Implementation notes` table with, at least: `set_wallet_space` now prefers the most recently joined household (Task 2); `leave_space` returns three counts, not four, because a mixed budget always keeps a wallet (Task 4); the confirm dialog states the rule rather than counts, and the counts arrive in the status line afterwards (Task 7).

- [ ] **Step 4: Commit and push the branch**

```bash
git add e2e/sharing.spec.ts docs/superpowers/specs/2026-09-06-household-sharing-design.md
git commit -m "test: household invite, share, and leave end to end"
git push -u origin feat/household-sharing
```

- [ ] **Step 5: Before hosted rollout (not part of the branch)**

Run read-only against hosted, and confirm with both people in the real household which of them the demotion rule keeps:

```sql
select sm.space_id, p.display_name, sm.joined_at
  from space_members sm join profiles p on p.id = sm.user_id
 where sm.role = 'owner' order by sm.space_id, sm.joined_at;
```

Then merge, push main, and `npx supabase db push` during the build, as with 0022.

---

## Self-review

**Spec coverage.** §3.1 → Task 1 (via, flag) and Task 3 (space_invites). §3.2 → Task 1 section B. §3.3 invariants → Task 2 (trigger + function), Task 1 section D (no direct writes). §4 functions → Tasks 2, 3, 4 (`is_space_owner` added as a helper; `get_wallet_sharing` Task 4). §5 grants → each task's revoke/grant lines; `wallets.shared_with_household` stays out of the UPDATE grant because nothing adds it. §6 → Task 4. §7.1 → Task 7. §7.2, §7.3 → Task 8. §8 → tests in Tasks 1–4, 5–8, and 9. §9 → Task 9 Step 5.

**Placeholders.** None: every step has its code or its exact assertion. Task 7 Step 6 and Task 8 Steps 2–4 describe edits to existing files in prose with the exact props, selects, and names, because the surrounding code is already in the repo and the executor edits in place.

**Type consistency.** `via` is `"owner" | "household" | "direct"` everywhere; `SharingMember.via` allows `null` for "no access" and only the UI uses that. `set_wallet_sharing` args are `p_wallet, p_household, p_direct` in SQL, the action, and the tests. `leave_space` / `remove_space_member` return `(wallets_moved, budgets_moved, budgets_trimmed)` in SQL, the fixture, and `LeaveSummary`. `PendingInvite` is `{ id, kind, name }` after Task 8 in both the component and the page.
