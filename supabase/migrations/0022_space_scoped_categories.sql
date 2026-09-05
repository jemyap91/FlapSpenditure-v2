-- supabase/migrations/0022_space_scoped_categories.sql
--
-- Categories move from belonging to a WALLET to belonging to a SPACE -- a
-- household (spec 2026-09-05). This supersedes the scoping decision 0008 made.
--
-- ## Why 0008 is being revisited, and why this is not a revert
--
-- 0008 moved categories from the USER to the WALLET to close a real bug: a
-- co-member could read a shared wallet's transactions but not the category
-- rows they pointed at, so a partner's rows rendered "Uncategorised" in the
-- list while get_category_breakdown (SECURITY DEFINER, RLS-bypassing) showed
-- the same category's name on the dashboard. The invariant 0008 was
-- protecting is:
--
--     everyone who can read a transaction must be able to read its category.
--
-- Wallet scoping satisfies that by construction. Its cost is that "the
-- category list" does not exist -- only "this wallet's list" does. With nine
-- wallets that is nine lists and ~144 rows: the /categories screen needs a
-- wallet chip row to ask which one you mean, a category created against one
-- wallet is not offerable when editing a transaction in another (the UI
-- filters, and transactions_category_same_wallet makes it impossible anyway),
-- and a rename touches one copy of nine.
--
-- Going back to user scoping would re-open 0008's bug exactly. The scope that
-- satisfies the invariant WITHOUT fragmenting the list is the household, and
-- that is what this migration introduces. 0008's invariant is preserved --
-- strengthened, in fact: see wallet_members_in_space below, which makes it a
-- schema property rather than something the application maintains.
--
-- ## Ordering
--
-- As in 0008, the backfill transiently violates constraints that are in
-- force, so the order below is load-bearing and is called out at each step.
--
-- ## Scope
--
-- Budgets are NOT touched here. 0013 rebuilt `budgets` with `category_key` as
-- a NAME with no foreign key to categories, so budgets never depended on
-- categories.wallet_id and keep working unchanged across this migration --
-- the names still exist, merely deduplicated and space-scoped. Converting
-- them back to a real category_id is 0023, deliberately a separate
-- transaction so that this one lands in a coherent state on its own.

-- ─────────────────────────────────────────────────────────────────────────
-- A. Space infrastructure
-- ─────────────────────────────────────────────────────────────────────────

create table spaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);

create table space_members (
  space_id  uuid not null references spaces(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      member_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

create index space_members_user on space_members (user_id);

-- Mirrors is_wallet_member (0004) exactly, and for the same reason: a policy
-- on space_members that queried space_members would recurse. SECURITY DEFINER
-- breaks the cycle; `set search_path = ''` stops a caller redirecting the
-- lookup through pg_temp (0004/0007 document the exploit this closes).
create function is_space_member(s uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.space_members
    where space_id = s and user_id = auth.uid()
  )
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- B. One space per connected component of the wallet-sharing graph
-- ─────────────────────────────────────────────────────────────────────────
-- Nodes are wallets; two wallets share an edge when at least one user is a
-- member of both. Every wallet in a component lands in one space, so a
-- household that shares anything shares one category list, while two people
-- who share nothing keep separate spaces.
--
-- Label propagation with a minimum root, iterated to a fixed point. It
-- terminates because `root` only ever decreases and is bounded below; the
-- loop exits on the first pass that changes nothing.

alter table wallets add column space_id uuid references spaces(id);

create temporary table comp(wallet_id uuid primary key, root uuid not null) on commit drop;
insert into comp (wallet_id, root) select id, id from wallets;

do $$
begin
  loop
    update comp c
       set root = sub.min_root
      from (
        -- `min(c3.root::text)::uuid`, not `min(c3.root)`: Postgres has no
        -- min/max aggregate for uuid at all, though it compares them with
        -- `<` perfectly well. The cast is order-preserving -- uuid compares
        -- bytewise over its 16 bytes and the canonical text form renders
        -- exactly those bytes as fixed-width lowercase hex -- so text order
        -- and uuid order agree, and the root chosen is the same one a
        -- native aggregate would choose.
        select c2.wallet_id, min(c3.root::text)::uuid as min_root
          from comp c2
          join wallet_members m2 on m2.wallet_id = c2.wallet_id
          join wallet_members m3 on m3.user_id   = m2.user_id
          join comp c3          on c3.wallet_id  = m3.wallet_id
         group by c2.wallet_id
      ) sub
     where sub.wallet_id = c.wallet_id
       and sub.min_root  < c.root;
    exit when not found;
  end loop;
end $$;

create temporary table space_map(root uuid primary key, space_id uuid not null default gen_random_uuid())
  on commit drop;
insert into space_map (root) select distinct root from comp;

-- Named from the root wallet's owner. `left(..., 49)` keeps the result inside
-- the 60-character CHECK even for a long display_name.
insert into spaces (id, name)
select sm.space_id,
       left(coalesce(nullif(btrim(p.display_name), ''), 'My'), 49) || ' household'
  from space_map sm
  join wallets w  on w.id = sm.root
  left join profiles p on p.id = w.owner_id;

update wallets w
   set space_id = sm.space_id
  from comp c
  join space_map sm on sm.root = c.root
 where c.wallet_id = w.id;

alter table wallets alter column space_id set not null;

-- The anchor every "same space" composite FK below hangs off.
alter table wallets add constraint wallets_id_space_unique unique (id, space_id);

-- Space membership is derived from wallet membership, so nobody gains or
-- loses reach in this migration. `owner` if they own any wallet in the space.
insert into space_members (space_id, user_id, role, joined_at)
select w.space_id,
       m.user_id,
       case when bool_or(m.role = 'owner') then 'owner'::member_role
            else 'member'::member_role end,
       min(m.joined_at)
  from wallet_members m
  join wallets w on w.id = m.wallet_id
 group by w.space_id, m.user_id;

-- ─────────────────────────────────────────────────────────────────────────
-- C. Membership becomes structurally impossible to get wrong
-- ─────────────────────────────────────────────────────────────────────────
-- wallet_members_in_space is the load-bearing constraint of this migration.
-- It makes 0008's invariant a schema property: a row CANNOT exist granting
-- someone access to a wallet unless they are also a member of that wallet's
-- space, and therefore can read the categories its transactions reference.
--
-- Section K adds a BEFORE INSERT trigger that satisfies this constraint
-- rather than leaving every caller to satisfy it by hand. That does not make
-- the foreign key decorative, and the division of labour is deliberate: the
-- FK is the GUARANTEE (nothing, including a future code path nobody has
-- written yet, can produce a violating row), while the trigger is the
-- CONVENIENCE (a caller adding someone to a wallet does not have to know
-- that households exist). accept_wallet_invite already performed exactly
-- this two-table insert; the trigger is that behaviour applied uniformly.

alter table wallet_members add column space_id uuid;
update wallet_members m set space_id = w.space_id from wallets w where w.id = m.wallet_id;
alter table wallet_members alter column space_id set not null;

alter table wallet_members
  add constraint wallet_members_wallet_same_space
    foreign key (wallet_id, space_id) references wallets (id, space_id) on delete cascade,
  add constraint wallet_members_in_space
    foreign key (space_id, user_id) references space_members (space_id, user_id) on delete cascade;

-- ─────────────────────────────────────────────────────────────────────────
-- D. Merge the per-wallet category copies
-- ─────────────────────────────────────────────────────────────────────────
-- Every DISTINCT name survives (design decision, 2026-09-05): a wallet whose
-- "Transport" was renamed to "Public Transport" contributes a second
-- category rather than being quietly folded into the first. Only exact
-- duplicates under (space, kind, lower(btrim(name))) are merged, which is
-- precisely the key the new unique index will enforce.
--
-- The surviving row is an EXISTING row, not a fresh insert, so every
-- transaction already pointing at the winner needs no repoint at all and
-- keeps its category id across the migration.

alter table categories add column space_id uuid references spaces(id) on delete cascade;

create temporary table cat_rep(old_id uuid primary key, rep_id uuid not null, space_id uuid not null)
  on commit drop;

with scored as (
  select c.id,
         w.space_id,
         c.kind,
         lower(btrim(c.name))     as key,
         (c.archived_at is null)  as active,
         c.created_at,
         (select count(*) from transactions t where t.category_id = c.id) as usage
    from categories c
    join wallets w on w.id = c.wallet_id
),
rep as (
  -- Active always beats archived: the new unique index covers only
  -- `archived_at is null` rows, so folding an active row into an archived one
  -- would silently retire a category still in use. Then most-used, so a
  -- customised icon/colour that is actually in service beats an untouched
  -- default. Oldest breaks the remaining ties deterministically.
  select distinct on (space_id, kind, key) id as rep_id, space_id, kind, key
    from scored
   order by space_id, kind, key, active desc, usage desc, created_at asc
)
insert into cat_rep (old_id, rep_id, space_id)
select s.id, r.rep_id, s.space_id
  from scored s
  join rep r on r.space_id = s.space_id and r.kind = s.kind and r.key = s.key;

-- The old constraints must go BEFORE the repoint: transactions_category_
-- same_wallet is still in force and the winning category generally lives in a
-- different wallet, so every repoint would violate it.
alter table transactions    drop constraint transactions_category_same_wallet;
alter table recurring_rules drop constraint recurring_rules_category_same_wallet;
alter table categories      drop constraint categories_id_wallet_unique;
drop index categories_unique_active_name;
drop index categories_wallet;

update transactions t
   set category_id = m.rep_id
  from cat_rep m
 where m.old_id = t.category_id and m.rep_id <> t.category_id;

update recurring_rules r
   set category_id = m.rep_id
  from cat_rep m
 where m.old_id = r.category_id and m.rep_id <> r.category_id;

-- Losers are deleted only after the repoint. transactions.category_id and
-- recurring_rules.category_id are both ON DELETE RESTRICT, so this statement
-- is itself a guard: if any repoint above had missed a row, this DELETE would
-- fail loudly rather than orphan it.
delete from categories c
 where exists (select 1 from cat_rep m where m.old_id = c.id and m.rep_id <> c.id);

update categories c set space_id = m.space_id from cat_rep m where m.old_id = c.id;

do $$
declare v int;
begin
  select count(*) into v from categories where space_id is null;
  if v > 0 then
    raise exception '0022: % categor(y/ies) ended the merge with no space', v;
  end if;
  select count(*) into v
    from transactions t
    left join categories c on c.id = t.category_id
   where t.category_id is not null and c.id is null;
  if v > 0 then
    raise exception '0022: % transaction(s) reference a category the merge deleted', v;
  end if;
end $$;

alter table categories alter column space_id set not null;

-- The policy swap must happen BEFORE wallet_id is dropped: categories_member
-- reads wallet_id in both its `using` and `with check` clauses, so Postgres
-- refuses the drop while it exists ("cannot drop column wallet_id ... policy
-- categories_member depends on it"). Exactly the ordering 0008 called out for
-- categories_own and owner_id, one column and one policy later.
drop policy categories_member on categories;
create policy categories_space on categories
  for all to authenticated
  using (is_space_member(space_id)) with check (is_space_member(space_id));

alter table categories drop column wallet_id;

create unique index categories_unique_active_name
  on categories (space_id, kind, lower(btrim(name)))
  where archived_at is null;
create index categories_space on categories (space_id, kind) where archived_at is null;

alter table categories add constraint categories_id_space_unique unique (id, space_id);

-- ─────────────────────────────────────────────────────────────────────────
-- E. space_id on the dependants, and the invariant chain
-- ─────────────────────────────────────────────────────────────────────────
-- space_id here is denormalised exactly as currency_code already is for
-- transactions_currency_matches_wallet (0015). It is not a second source of
-- truth: the *_wallet_same_space constraint re-derives it from the wallet on
-- every write, so a wrong value is rejected rather than believed.

alter table transactions add column space_id uuid;
update transactions t set space_id = w.space_id from wallets w where w.id = t.wallet_id;
alter table transactions alter column space_id set not null;

alter table recurring_rules add column space_id uuid;
update recurring_rules r set space_id = w.space_id from wallets w where w.id = r.wallet_id;
alter table recurring_rules alter column space_id set not null;

alter table transactions
  add constraint transactions_wallet_same_space
    foreign key (wallet_id, space_id) references wallets (id, space_id) on delete cascade,
  -- MATCH SIMPLE (the default) skips the check when category_id is null,
  -- which is exactly right for transfers -- the same behaviour
  -- transactions_category_same_wallet had.
  add constraint transactions_category_same_space
    foreign key (category_id, space_id) references categories (id, space_id) on delete restrict;

alter table recurring_rules
  add constraint recurring_rules_wallet_same_space
    foreign key (wallet_id, space_id) references wallets (id, space_id) on delete cascade,
  -- Not nullable here: every rule requires a category, so this always fires.
  add constraint recurring_rules_category_same_space
    foreign key (category_id, space_id) references categories (id, space_id) on delete restrict;

-- ─────────────────────────────────────────────────────────────────────────
-- F. Policies
-- ─────────────────────────────────────────────────────────────────────────

alter table spaces        enable row level security;
alter table space_members enable row level security;

create policy spaces_member on spaces
  for select to authenticated using (is_space_member(id));
create policy space_members_select on space_members
  for select to authenticated using (is_space_member(space_id));

-- ─────────────────────────────────────────────────────────────────────────
-- G. Grants
-- ─────────────────────────────────────────────────────────────────────────
-- Reachability first: this project's default ACL for schema public gives
-- authenticated no DML, so a policy without a grant is dead code (0004).
-- `revoke all` first also removes table-level TRUNCATE, which is NOT subject
-- to RLS. Same shape as 0015 used for recurring_rules.
revoke all on spaces        from anon, authenticated;
revoke all on space_members from anon, authenticated;
grant select on spaces        to authenticated;
grant select on space_members to authenticated;
-- No INSERT/UPDATE/DELETE to anyone. A space is created by handle_new_user
-- and membership by accept_wallet_invite, both SECURITY DEFINER. There is no
-- user-facing operation that writes either table directly, so granting
-- nothing is not a restriction to work around later -- it is the boundary.

-- 0004 granted UPDATE table-wide on wallets and wallet_members, and Postgres
-- grants are ADDITIVE -- a later column-scoped grant never narrows an earlier
-- table-wide one; only a revoke does. 0018 narrowed categories for exactly
-- this reason. Both tables now carry space_id, which must never be writable:
-- it is what pins a wallet, its members, and its transactions to one
-- household. Narrowed to everything that was updatable before, minus space_id
-- (and minus the structural columns that were never meant to be, which is the
-- untidiness 0018's comment flagged and left).
revoke update on wallets from authenticated;
grant update (name, kind, currency_code, starting_balance_minor,
              color_slot, icon, archived_at, updated_at)
  on wallets to authenticated;

revoke update on wallet_members from authenticated;
grant update (role) on wallet_members to authenticated;

-- transactions and recurring_rules need no revoke: their UPDATE grants are
-- already column-scoped (0004/0015/0016/0017), so the space_id column added
-- above is excluded by construction. categories likewise keeps 0018's
-- (name, color_slot, icon, sort_order, archived_at) -- space_id is absent
-- from that list and must stay absent, or a user in two spaces could move a
-- category between them through the USING/WITH CHECK gap 0004 documents.

-- ─────────────────────────────────────────────────────────────────────────
-- H. Seeding moves up one level
-- ─────────────────────────────────────────────────────────────────────────
-- 0008 moved seeding from the user trigger to the wallet trigger so every
-- wallet started with the defaults. That is now the cause of the duplication
-- this migration exists to remove, so it moves once more: to the space. A new
-- WALLET seeds nothing.

drop trigger wallets_seed_categories on wallets;
drop function seed_wallet_categories();

create function seed_space_categories() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categories (space_id, name, kind, color_slot, icon, sort_order, is_default) values
    (new.id,'Groceries',    'expense', 1,'shopping-basket', 1,true),
    (new.id,'Eating out',   'expense', 2,'utensils',        2,true),
    (new.id,'Transport',    'expense', 3,'bus',             3,true),
    (new.id,'Housing',      'expense', 4,'house',           4,true),
    (new.id,'Utilities',    'expense', 5,'plug',            5,true),
    (new.id,'Health',       'expense', 6,'heart-pulse',     6,true),
    (new.id,'Entertainment','expense', 7,'clapperboard',    7,true),
    (new.id,'Shopping',     'expense', 8,'shopping-bag',    8,true),
    (new.id,'Travel',       'expense', 9,'plane',           9,true),
    (new.id,'Education',    'expense',10,'graduation-cap', 10,true),
    (new.id,'Subscriptions','expense',11,'repeat',         11,true),
    (new.id,'Other',        'expense',12,'circle-ellipsis',12,true),
    (new.id,'Salary',       'income', 13,'wallet',          1,true),
    (new.id,'Bonus',        'income', 14,'gift',            2,true),
    (new.id,'Interest',     'income', 15,'piggy-bank',      3,true),
    (new.id,'Other income', 'income', 16,'circle-plus',     4,true)
  on conflict do nothing;
  return new;
end $$;

create trigger spaces_seed_categories after insert on spaces
  for each row execute function seed_space_categories();

-- A brand-new account now gets its household before it has any wallet, so the
-- category list exists from first login rather than appearing with the first
-- wallet. Replaces the 0008 version, which seeded only the profile.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_space uuid;
begin
  insert into public.profiles (id, display_name)
    values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;

  -- `on conflict do nothing` above makes a re-fired signup a no-op; the guard
  -- here is the equivalent for the space, so a retried webhook cannot mint a
  -- second household (and a second set of 16 categories) for one user.
  select sm.space_id into v_space
    from public.space_members sm where sm.user_id = new.id limit 1;

  if v_space is null then
    insert into public.spaces (name)
      values (left(coalesce(nullif(split_part(new.email, '@', 1), ''), 'My'), 49) || ' household')
      returning id into v_space;
    insert into public.space_members (space_id, user_id, role)
      values (v_space, new.id, 'owner');
  end if;

  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- I. A wallet's space is decided by the server, never by the client
-- ─────────────────────────────────────────────────────────────────────────
-- INSERT on wallets is a plain table-level grant (0004), and wallets_owner
-- only checks owner_id = auth.uid() -- it says nothing about space_id. Without
-- this trigger an authenticated caller could POST a wallet carrying ANOTHER
-- household's space_id and have its categories, transactions and members
-- filed there. The value is therefore overwritten from the session rather
-- than validated, so there is nothing to get past.
--
-- Derived from new.owner_id, NOT from auth.uid(). For a PostgREST caller the
-- two are the same value -- wallets_owner's `with check (owner_id =
-- auth.uid())` pins it -- but owner_id is also populated on the superuser
-- path, where auth.uid() is null. One rule therefore covers both, and every
-- existing fixture and seed keeps inserting wallets without a space_id.
create function set_wallet_space() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_space uuid;
begin
  select sm.space_id into v_space
    from public.space_members sm
   where sm.user_id = new.owner_id
   order by (sm.role = 'owner') desc, sm.joined_at asc
   limit 1;

  -- handle_new_user gives every account a household at signup, so this is
  -- reachable only for a fixture that inserted into auth.users before this
  -- migration ran. Creating one is better than failing: the alternative is a
  -- wallet that cannot exist, and a household with no members is not a thing
  -- this schema can represent anyway.
  if v_space is null then
    insert into public.spaces (name) values ('Household') returning id into v_space;
    insert into public.space_members (space_id, user_id, role)
      values (v_space, new.owner_id, 'owner');
  end if;

  new.space_id := v_space;
  return new;
end $$;

create trigger wallets_set_space before insert on wallets
  for each row execute function set_wallet_space();

-- ─────────────────────────────────────────────────────────────────────────
-- J. Accepting a wallet invite must also join the space
-- ─────────────────────────────────────────────────────────────────────────
-- wallet_members_in_space now refuses the membership row outright unless the
-- space_members row already exists, so without this the invite flow would
-- break with a foreign-key error. Joining the space is not an extra
-- permission being granted quietly: it is what makes the wallet access the
-- invite already conveys actually usable, since the wallet's transactions
-- reference the space's categories.
create or replace function accept_wallet_invite(invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  inv public.wallet_invites;
  caller_email text := lower(btrim(auth.jwt() ->> 'email'));
begin
  select * into inv from public.wallet_invites where id = invite for update;

  if inv is null or inv.status <> 'pending' then
    raise exception 'invite is not open';
  end if;
  if caller_email is null or lower(btrim(inv.invited_email)) <> caller_email then
    raise exception 'invite is addressed to someone else';
  end if;

  -- sync_wallet_member_space (section K) fills space_id and adds the
  -- household membership, so this insert stays the single statement it was.
  insert into public.wallet_members (wallet_id, user_id, role)
  values (inv.wallet_id, auth.uid(), 'member')
  on conflict (wallet_id, user_id) do nothing;

  update public.wallet_invites
  set status = 'accepted', responded_at = now()
  where id = invite;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- K. The wallet creator's own membership row
-- ─────────────────────────────────────────────────────────────────────────
-- Every path into wallet_members -- add_owner_as_member (0002), the invite
-- flow, an owner's direct insert under members_write, a test fixture --
-- now needs two things it previously did not: a space_id, and a matching
-- space_members row for wallet_members_in_space to reference. Doing that
-- here, once, is what keeps all of them working rather than editing each
-- and hoping none was missed.
--
-- Joining the household is not a quiet extra grant. Wallet membership
-- already exposes every transaction in that wallet; what the space
-- membership adds is the ability to READ THE CATEGORY NAMES those
-- transactions point at -- without which they would render "Uncategorised",
-- which is precisely the bug 0008 was written to fix. The alternative
-- (refusing the row) would leave members_write's INSERT permission
-- unusable, and accept_wallet_invite already did this exact two-table
-- insert by hand.
create function sync_wallet_member_space() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_space uuid;
begin
  select w.space_id into v_space from public.wallets w where w.id = new.wallet_id;
  new.space_id := v_space;

  insert into public.space_members (space_id, user_id, role)
  values (v_space, new.user_id, 'member')
  on conflict (space_id, user_id) do nothing;

  return new;
end $$;

create trigger wallet_members_set_space before insert on wallet_members
  for each row execute function sync_wallet_member_space();

-- add_owner_as_member (0002) can now stay exactly as it was: the trigger
-- above supplies space_id and the household membership. Recreated only to
-- record that this was checked rather than overlooked.
create or replace function add_owner_as_member() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.wallet_members (wallet_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- L. move_transaction carries the space with the wallet
-- ─────────────────────────────────────────────────────────────────────────
-- 0020's version sets wallet_id and leaves space_id untouched, which
-- transactions_wallet_same_space now refuses for any move that crosses
-- households -- and silently mis-describes the row for any that does not.
-- The destination wallet's space is the only correct value, and reading it
-- from the wallet rather than accepting it as a parameter keeps the caller
-- unable to name a different one.
--
-- Note what this deliberately does NOT relax: the member-superset rule and
-- the transfer refusal below are 0020's, unchanged. A cross-household move
-- that survives them still has to satisfy transactions_category_same_space,
-- which is what forces the category to be cleared or re-chosen -- the
-- refusal updateTransaction used to make by hand for EVERY move, and now
-- correctly makes only for this one.
create or replace function move_transaction(
  p_id           uuid,
  p_wallet_id    uuid,
  p_amount_minor bigint,
  p_occurred_on  date,
  p_category_id  uuid default null,
  p_note         text default null,
  p_merchant     text default null
) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  v_caller  uuid := auth.uid();
  v_source  uuid;
  v_kind    public.txn_kind;
  v_orphans int;
  v_space   uuid;
begin
  if v_caller is null then
    raise exception 'not signed in';
  end if;

  select wallet_id, kind into v_source, v_kind
    from public.transactions
   where id = p_id and deleted_at is null;
  if v_source is null then
    raise exception 'transaction not found';
  end if;

  if v_kind = 'transfer' then
    raise exception 'a transfer cannot be moved between wallets';
  end if;

  if not public.is_wallet_member(v_source) then
    raise exception 'transaction not found';
  end if;
  if not public.is_wallet_member(p_wallet_id) then
    raise exception 'not a member of the destination wallet';
  end if;

  select count(*) into v_orphans
    from public.wallet_members src
   where src.wallet_id = v_source
     and not exists (
       select 1 from public.wallet_members dst
        where dst.wallet_id = p_wallet_id
          and dst.user_id = src.user_id
     );
  if v_orphans > 0 then
    raise exception
      'moving this would hide it from % other member(s) of the wallet it is in', v_orphans;
  end if;

  select space_id into v_space from public.wallets where id = p_wallet_id;

  update public.transactions
     set wallet_id    = p_wallet_id,
         space_id     = v_space,
         category_id  = p_category_id,
         amount_minor = p_amount_minor,
         occurred_on  = p_occurred_on,
         note         = p_note,
         merchant     = p_merchant,
         updated_at   = now()
   where id = p_id and deleted_at is null;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- M. space_id fills itself in when it is not supplied
-- ─────────────────────────────────────────────────────────────────────────
-- space_id is DERIVED data: a row's household is its wallet's household and
-- can be nothing else. Requiring every caller to restate it would be a rule
-- with no judgement in it and one more thing to get wrong.
--
-- This fills the column only when it arrives NULL; it does not overwrite a
-- supplied value, because it does not need to. The composite FKs from
-- section E (transactions_wallet_same_space, recurring_rules_wallet_same_
-- space) re-derive it from the wallet on every write, so a WRONG value is
-- rejected outright rather than quietly corrected -- a caller who supplies
-- one is checked, and a caller who omits one is served.
--
-- Contrast set_wallet_space (section I), which DOES overwrite: there the
-- value is a security decision (which household a new wallet joins) with no
-- constraint able to check it, so the server must choose rather than verify.
create function set_row_space() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.space_id is null then
    select w.space_id into new.space_id from public.wallets w where w.id = new.wallet_id;
  end if;
  return new;
end $$;

-- BEFORE INSERT, so it runs ahead of the NOT NULL check -- Postgres evaluates
-- column constraints after BEFORE ROW triggers, which is what lets the column
-- be omitted entirely by a caller that has no reason to know it.
create trigger transactions_set_space before insert on transactions
  for each row execute function set_row_space();
create trigger recurring_rules_set_space before insert on recurring_rules
  for each row execute function set_row_space();
