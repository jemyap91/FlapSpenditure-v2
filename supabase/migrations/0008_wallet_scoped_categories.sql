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
--
-- Ordering note: the backfill below deliberately produces MULTIPLE category
-- rows per owner_id -- one copy per wallet that owner has -- while owner_id
-- is still NOT NULL and still carried on every row (it isn't dropped until
-- after transactions are repointed and the guard has passed). The OLD
-- unique index categories_unique_active_name is keyed on (owner_id, kind,
-- lower(btrim(name))); left in force across the backfill, a multi-wallet
-- owner's second wallet collides against the first wallet's copy the moment
-- it's inserted, since both copies carry the same owner_id. So the
-- owner-scoped indexes are dropped BEFORE the backfill runs, not after, and
-- the new wallet-scoped indexes are created only once owner_id is gone.

-- 1. Nullable first: the backfill below has to run before NOT NULL can hold.
alter table categories add column wallet_id uuid references wallets(id) on delete cascade;

-- 2. Drop the owner-scoped indexes before the backfill creates multiple rows
--    per owner_id -- see the ordering note above.
drop index categories_unique_active_name;
drop index categories_owner;

-- 3. Copy each owner's categories into each wallet they own. `wallet_id is
--    null` identifies the pre-migration originals, so the copies this
--    statement creates are not themselves re-copied. owner_id is carried
--    through explicitly: the column is still NOT NULL at this point.
insert into categories (owner_id, wallet_id, name, kind, color_slot, icon, sort_order, is_default, archived_at, created_at)
select c.owner_id, w.id, c.name, c.kind, c.color_slot, c.icon, c.sort_order, c.is_default, c.archived_at, c.created_at
from wallets w
join categories c on c.owner_id = w.owner_id
where c.wallet_id is null;

-- 4. Repoint every transaction at the copy belonging to its OWN wallet,
--    matched on the same (kind, lower(btrim(name))) pair the old uniqueness
--    index used, AND on archived_at status: that index only covered active
--    rows (where archived_at is null), so an owner could legitimately hold
--    both an active and an archived category sharing a (kind, name) --
--    matching on name alone could repoint a transaction to the archived
--    copy instead of the active one it actually referenced.
--    Transfers have category_id null and are untouched.
update transactions t
set category_id = new_c.id
from categories old_c
join wallets w      on w.owner_id = old_c.owner_id
join categories new_c
  on new_c.wallet_id = w.id
 and new_c.kind = old_c.kind
 and lower(btrim(new_c.name)) = lower(btrim(old_c.name))
 and new_c.archived_at is not distinct from old_c.archived_at
where t.category_id = old_c.id
  and t.wallet_id = w.id
  and old_c.wallet_id is null;

-- 5. Fail loudly rather than silently orphan a reference: if any transaction
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

-- 6. Originals are no longer referenced by anything (guarded above); remove
--    them and lock wallet_id down.
delete from categories where wallet_id is null;
alter table categories alter column wallet_id set not null;

-- 7. Swap the policy from owner to wallet. This must happen before owner_id
--    is dropped: categories_own reads owner_id in its USING clause.
drop policy categories_own on categories;
create policy categories_member on categories
  for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));

-- 8. owner_id has done its job (carried the backfill, matched the repoint);
--    drop it now that every row is wallet-scoped.
alter table categories drop column owner_id;

-- 9. Create the wallet-scoped indexes now that owner_id is gone and every
--    row has a wallet_id.
create unique index categories_unique_active_name
  on categories (wallet_id, kind, lower(btrim(name)))
  where archived_at is null;
create index categories_wallet on categories (wallet_id, kind) where archived_at is null;

-- 10. A transaction may not reference another wallet's category. RLS cannot
--     express this and nothing enforced it before; wallet-scoping is what
--     makes the violation reachable, so the constraint ships with it.
--     MATCH SIMPLE (the default) skips the check when category_id is null,
--     which is exactly right for transfers.
alter table categories add constraint categories_id_wallet_unique unique (id, wallet_id);
alter table transactions
  add constraint transactions_category_same_wallet
  foreign key (category_id, wallet_id) references categories (id, wallet_id);

-- 11. Seeding moves from the user trigger to a wallet trigger, so every
--     wallet -- first or fifth -- starts with the 16 defaults (spec §1).
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
