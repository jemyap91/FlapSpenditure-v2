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
