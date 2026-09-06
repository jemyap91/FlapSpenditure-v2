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

-- ─────────────────────────────────────────────────────────────────────────
-- G0. A member's new wallet joins the household they joined
-- ─────────────────────────────────────────────────────────────────────────
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
