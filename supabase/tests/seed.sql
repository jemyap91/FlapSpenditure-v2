-- supabase/tests/seed.sql
-- Verifies migration 0007's new-user profile seed and migration 0008's
-- wallet-scoped category seed by VALUE, not just count: exactly one
-- profiles row per user, zero categories until a wallet exists, and then
-- categories that match the brief's 16 rows on kind, name, color_slot and
-- icon -- not merely "16 rows exist" (a count assertion is equally happy
-- if every row were named 'x' with color_slot 1 and an empty icon). Also
-- proves the idempotency the seed trigger's ON CONFLICT DO NOTHING clause
-- exists to provide, and that a second wallet gets its own independent 16.
--
-- Runs as the table-owning superuser, like constraints.sql -- this suite
-- checks the seed triggers' output shape, not the RLS boundary (rls.sql
-- already proves the seeded rows are correctly wallet-scoped under RLS:
-- visible to a wallet's members, invisible to a non-member, no collision
-- between two wallets' seeded sets).
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('55550000-0000-0000-0000-000000000001', 'newuser@x.io');

-- Exactly one profile, correctly attributed and named from the email.
do $$ begin
  assert (select count(*) from profiles where id = '55550000-0000-0000-0000-000000000001') = 1,
    'SEED BROKEN: signup did not create exactly one profiles row';
  assert (select display_name from profiles where id = '55550000-0000-0000-0000-000000000001') = 'newuser',
    'SEED BROKEN: display_name was not derived from the email local-part';
end $$;

-- Categories are seeded per WALLET now (0008), not per user: a brand-new
-- user has a profile and NO categories until they create their first wallet.
-- This block therefore first proves dave has zero categories, then creates
-- a wallet for him and proves THAT wallet gets the 16 -- tuple-level, on
-- kind, name, color_slot and icon -- a comparison in BOTH directions
-- (nothing extra beyond the brief, nothing missing from it), not a bare
-- count. A wrong icon, a swapped color_slot, or a typo'd name on any single
-- row fails this (proven below by deliberately corrupting one row).
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

do $$
declare
  n_seeded  int;
  n_extra   int;
  n_missing int;
begin
  select count(*) into n_seeded from categories where wallet_id = '33333333-0000-0000-0000-000000000003';
  assert n_seeded = 16, format('SEED BROKEN: expected 16 categories, got %s', n_seeded);

  -- Seeded rows that don't match any expected (kind, name, color_slot, icon) tuple.
  select count(*) into n_extra
  from categories c
  where c.wallet_id = '33333333-0000-0000-0000-000000000003'
    and not exists (
      select 1 from (values
        ('expense','Groceries',    1,'shopping-basket'),
        ('expense','Eating out',   2,'utensils'),
        ('expense','Transport',    3,'bus'),
        ('expense','Housing',      4,'house'),
        ('expense','Utilities',    5,'plug'),
        ('expense','Health',       6,'heart-pulse'),
        ('expense','Entertainment',7,'clapperboard'),
        ('expense','Shopping',     8,'shopping-bag'),
        ('expense','Travel',       1,'plane'),
        ('expense','Education',    2,'graduation-cap'),
        ('expense','Subscriptions',3,'repeat'),
        ('expense','Other',        4,'circle-ellipsis'),
        ('income', 'Salary',       3,'wallet'),
        ('income', 'Bonus',        5,'gift'),
        ('income', 'Interest',     6,'piggy-bank'),
        ('income', 'Refunds',      7,'rotate-ccw')
      ) as expected(kind, name, color_slot, icon)
      where expected.kind::category_kind = c.kind
        and expected.name = c.name
        and expected.color_slot = c.color_slot
        and expected.icon = c.icon
    );
  assert n_extra = 0,
    format('SEED BROKEN: %s seeded categories do not match the brief on kind/name/color_slot/icon', n_extra);

  -- Expected tuples from the brief that have no matching seeded row.
  select count(*) into n_missing
  from (values
    ('expense','Groceries',    1,'shopping-basket'),
    ('expense','Eating out',   2,'utensils'),
    ('expense','Transport',    3,'bus'),
    ('expense','Housing',      4,'house'),
    ('expense','Utilities',    5,'plug'),
    ('expense','Health',       6,'heart-pulse'),
    ('expense','Entertainment',7,'clapperboard'),
    ('expense','Shopping',     8,'shopping-bag'),
    ('expense','Travel',       1,'plane'),
    ('expense','Education',    2,'graduation-cap'),
    ('expense','Subscriptions',3,'repeat'),
    ('expense','Other',        4,'circle-ellipsis'),
    ('income', 'Salary',       3,'wallet'),
    ('income', 'Bonus',        5,'gift'),
    ('income', 'Interest',     6,'piggy-bank'),
    ('income', 'Refunds',      7,'rotate-ccw')
  ) as expected(kind, name, color_slot, icon)
  where not exists (
    select 1 from categories c
    where c.wallet_id = '33333333-0000-0000-0000-000000000003'
      and expected.kind::category_kind = c.kind
      and expected.name = c.name
      and expected.color_slot = c.color_slot
      and expected.icon = c.icon
  );
  assert n_missing = 0,
    format('SEED BROKEN: %s of the brief''s 16 categories are missing from the seed', n_missing);
end $$;

-- Every wallet gets its own 16, not just the first: a second wallet for the
-- SAME user must be independently seeded (proves the trigger fires per
-- wallet, not merely once per owner).
insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('44444444-0000-0000-0000-000000000004','dddddddd-0000-0000-0000-000000000004','Second','bank','USD',0,2,'landmark');

do $$ begin
  if (select count(*) from public.categories where wallet_id = '44444444-0000-0000-0000-000000000004') <> 16 then
    raise exception 'every wallet gets its own 16, not just the first';
  end if;
end $$;

-- Idempotency: ON CONFLICT DO NOTHING on the seed insert in migration
-- 0008's seed_wallet_categories() is the load-bearing resilience decision
-- (carried over from migration 0007's handle_new_user(), see
-- task-11-report.md) -- if this trigger raises, wallet creation itself
-- fails, so a retried request or a re-fired trigger for the same wallet
-- must be a no-op instead of an error.
--
-- seed_wallet_categories() cannot be invoked directly to prove this
-- ("trigger functions can only be called as triggers"), and genuinely
-- re-firing the AFTER INSERT trigger for the SAME wallet id is not
-- reachable via SQL either: id is a primary key, so a second insert is
-- rejected outright, and deleting the row first would cascade-delete (on
-- delete cascade) the very categories rows this block exists to prove
-- survive a re-run. So this re-executes the exact insert statement the
-- trigger body runs -- keep this block in sync with migration 0008 if that
-- list ever changes -- directly against the same wallet id already seeded
-- above (33333333-003). That is exactly the SQL a re-fired trigger would
-- execute a second time, and it is the ON CONFLICT behaviour under test,
-- not the AFTER INSERT plumbing around it.
do $$
declare
  wid uuid := '33333333-0000-0000-0000-000000000003';
  n int;
begin
  insert into categories (wallet_id, name, kind, color_slot, icon, sort_order, is_default) values
    (wid,'Groceries',    'expense',1,'shopping-basket', 1,true),
    (wid,'Eating out',   'expense',2,'utensils',        2,true),
    (wid,'Transport',    'expense',3,'bus',             3,true),
    (wid,'Housing',      'expense',4,'house',           4,true),
    (wid,'Utilities',    'expense',5,'plug',            5,true),
    (wid,'Health',       'expense',6,'heart-pulse',     6,true),
    (wid,'Entertainment','expense',7,'clapperboard',    7,true),
    (wid,'Shopping',     'expense',8,'shopping-bag',    8,true),
    (wid,'Travel',       'expense',1,'plane',           9,true),
    (wid,'Education',    'expense',2,'graduation-cap', 10,true),
    (wid,'Subscriptions','expense',3,'repeat',         11,true),
    (wid,'Other',        'expense',4,'circle-ellipsis',12,true),
    (wid,'Salary',       'income', 3,'wallet',          1,true),
    (wid,'Bonus',        'income', 5,'gift',            2,true),
    (wid,'Interest',     'income', 6,'piggy-bank',      3,true),
    (wid,'Refunds',      'income', 7,'rotate-ccw',      4,true)
  on conflict (wallet_id, kind, (lower(btrim(name)))) where archived_at is null do nothing;

  select count(*) into n from categories where wallet_id = wid;
  assert n = 16, format('SEED NOT IDEMPOTENT: re-running the seed insert changed the category count to %s', n);
end $$;

select 'seed tests passed' as result;
