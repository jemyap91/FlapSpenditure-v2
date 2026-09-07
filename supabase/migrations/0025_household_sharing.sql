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
-- 'owner' explicitly below; only set_wallet_sharing and
-- accept_space_invite ever write 'household'.
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
-- accept_wallet_invite, add_owner_as_member and accept_space_invite
-- (section E). That is what makes "a household row exists only where its
-- owner or the household's invitation put it" a property nothing can break
-- by hand. Postgres grants are additive, so the 0004 grant is REVOKED, not
-- merely left un-granted (0018 and 0022 make the same point).
-- `if exists` and the anon half are hosted-drift insurance: the hosted
-- database was restored from a dump that re-granted anon, and a policy
-- dropped there by hand would fail a bare DROP POLICY here.
drop policy if exists members_write on wallet_members;
revoke insert, update, delete on wallet_members from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- E. Joining a household grants its shared wallets -- but only on a
--    household invitation, and deliberately NOT by trigger
-- ─────────────────────────────────────────────────────────────────────────
-- The grant lives inside accept_space_invite (section H), not in an insert
-- trigger on space_members, because space_members rows are also created by
-- paths that are nobody's decision to hand over other people's wallets:
--
--   * sync_wallet_member_space (0022) adds a space_members row whenever
--     accept_wallet_invite grants a wallet. ANY wallet owner can send that
--     invite -- a member of a household, not just its owner -- and 0022
--     designed that join to carry category NAMES only, so the invitee's
--     transactions can be filed. A trigger here would turn one member's
--     wallet invite into a grant of every household-shared wallet in the
--     household, the household owner's included.
--   * set_wallet_space (section G0) and handle_new_user (0022) create a
--     household with its first member in one step.
--
-- So: joining through a household invitation grants the household-shared
-- wallets (the owner invited you into the household); joining any other
-- way grants exactly what that path grants. A wallet shared with the
-- household AFTER you joined reaches you through set_wallet_sharing, which
-- its owner runs with the member list in front of them.
--
-- Leaving needs no trigger either: wallet_members_in_space (0022) is ON
-- DELETE CASCADE, so deleting a space_members row already removes that
-- user's rows on every wallet in the household. leave_space (section G)
-- moves the wallets they own out first, so the cascade never reaches an
-- owner row.

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
  -- Deduped up front: the INSERT below would otherwise raise "ON CONFLICT
  -- DO UPDATE cannot affect row a second time" on a repeated id, and the
  -- UI can post the same person twice from a stale form.
  p_direct := array(select distinct u from unnest(coalesce(p_direct, array[]::uuid[])) u);
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

-- get_pending_space_invites looks every invitee up by address; 0009 gives
-- wallet_invites the same partial index for the same read.
create index space_invites_invitee
  on space_invites (lower(btrim(invited_email))) where status = 'pending';

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
  insert into public.space_members (space_id, user_id, role)
  values (inv.space_id, auth.uid(), 'member')
  on conflict (space_id, user_id) do nothing;
  -- The household's shared wallets come with the invitation (section E
  -- says why this is here and not a trigger on space_members).
  insert into public.wallet_members (wallet_id, user_id, role, via)
  select w.id, auth.uid(), 'member', 'household'
    from public.wallets w
   where w.space_id = inv.space_id
     and w.shared_with_household
     and w.owner_id <> auth.uid()
  on conflict (wallet_id, user_id) do nothing;
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
  -- Transaction-scoped and never reset: SET CONSTRAINTS has no "back to
  -- immediate for the rest of this statement" and PostgreSQL gives no way
  -- to restore only the constraints this function deferred. Harmless under
  -- the one-RPC-per-transaction shape PostgREST gives every caller here.
  -- If this is ever called from inside a larger transaction, every key on
  -- that transaction's later statements is checked at COMMIT instead of at
  -- statement end -- same outcome, later and less locatable error.
  set constraints all deferred;

  select sm.role into v_role from public.space_members sm where sm.space_id = p_space and sm.user_id = p_user;
  if v_role is null then
    raise exception 'not a member of that household';
  end if;
  if v_role = 'owner' then
    raise exception 'the household owner cannot leave';
  end if;

  -- handle_new_user (0022) already gave this person a household at signup,
  -- dormant while they were a member elsewhere. Reuse it rather than
  -- minting another: without this, leaving-and-rejoining piles up empty
  -- owned households nobody can see a reason for.
  select sm.space_id into v_new
    from public.space_members sm
   where sm.user_id = p_user and sm.role = 'owner' and sm.space_id <> p_space
   order by sm.joined_at asc
   limit 1;
  if v_new is null then
    insert into public.spaces (name)
    values (left(coalesce((select nullif(btrim(p.display_name), '') from public.profiles p where p.id = p_user), 'My'), 49) || ' household')
    returning id into v_new;
    insert into public.space_members (space_id, user_id, role) values (v_new, p_user, 'owner');
  end if;

  select coalesce(array_agg(w.id), array[]::uuid[]) into v_wallets
    from public.wallets w where w.owner_id = p_user and w.space_id = p_space;

  select coalesce(array_agg(b.id), array[]::uuid[]) into v_moved_budgets
    from public.budgets b
   where b.space_id = p_space
     and exists (select 1 from public.budget_wallets bw where bw.budget_id = b.id)
     and not exists (select 1 from public.budget_wallets bw
                      where bw.budget_id = b.id and not (bw.wallet_id = any(v_wallets)));

  -- Categories the moving rows need, created in the new household where no
  -- active same-named one exists (the seed trigger already made 16). A
  -- category that exists in the destination only ARCHIVED is recreated
  -- active on purpose: the repoint joins below require `n.archived_at is
  -- null`, so an archived-only match would leave the moving rows pointing
  -- at the old household and the deferred key would fail at commit. The
  -- person can archive it again afterwards.
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

  -- Budgets trimmed, not links trimmed: a mixed budget can lose several
  -- wallets at once and the caller reports "n budgets kept their staying
  -- wallets", so count the budgets the deletion touched.
  with d as (
    delete from public.budget_wallets bw
     where bw.wallet_id = any(v_wallets) and not (bw.budget_id = any(v_moved_budgets))
    returning bw.budget_id)
  select count(distinct budget_id) into v_trimmed from d;

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
