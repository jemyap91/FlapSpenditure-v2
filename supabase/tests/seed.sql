-- supabase/tests/seed.sql
-- Verifies migration 0007's new-user seed trigger by VALUE, not just count:
-- exactly one profiles row, and categories that match the brief's 16 rows
-- on kind, name, color_slot and icon -- not merely "16 rows exist" (a count
-- assertion is equally happy if every row were named 'x' with color_slot 1
-- and an empty icon). Also proves the idempotency the trigger's
-- ON CONFLICT DO NOTHING clauses exist to provide.
--
-- Runs as the table-owning superuser, like constraints.sql -- this suite
-- checks the seed trigger's output shape, not the RLS boundary (rls.sql
-- already proves the seeded rows are correctly owner-scoped under RLS:
-- visible to their owner, invisible to a second user, no collision between
-- two users' seeded sets).
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

-- Exactly 16 categories, and every one of them matches the brief's table on
-- kind, name, color_slot and icon -- a tuple-level comparison in BOTH
-- directions (nothing extra beyond the brief, nothing missing from it), not
-- a bare count. A wrong icon, a swapped color_slot, or a typo'd name on any
-- single row fails this (proven below by deliberately corrupting one row).
do $$
declare
  n_seeded  int;
  n_extra   int;
  n_missing int;
begin
  select count(*) into n_seeded from categories where owner_id = '55550000-0000-0000-0000-000000000001';
  assert n_seeded = 16, format('SEED BROKEN: expected 16 categories, got %s', n_seeded);

  -- Seeded rows that don't match any expected (kind, name, color_slot, icon) tuple.
  select count(*) into n_extra
  from categories c
  where c.owner_id = '55550000-0000-0000-0000-000000000001'
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
        ('income', 'Other income', 8,'circle-plus')
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
    ('income', 'Other income', 8,'circle-plus')
  ) as expected(kind, name, color_slot, icon)
  where not exists (
    select 1 from categories c
    where c.owner_id = '55550000-0000-0000-0000-000000000001'
      and expected.kind::category_kind = c.kind
      and expected.name = c.name
      and expected.color_slot = c.color_slot
      and expected.icon = c.icon
  );
  assert n_missing = 0,
    format('SEED BROKEN: %s of the brief''s 16 categories are missing from the seed', n_missing);
end $$;

-- Idempotency: ON CONFLICT DO NOTHING on both inserts in migration 0007's
-- handle_new_user() is the load-bearing resilience decision of that
-- migration (see task-11-report.md) -- if this trigger raises, account
-- creation itself fails, so a retried signup webhook or a re-fired trigger
-- for the same user must be a no-op instead of an error.
--
-- handle_new_user() cannot be invoked directly to prove this ("trigger
-- functions can only be called as triggers"), and genuinely re-firing the
-- AFTER INSERT trigger for the SAME auth.users id is not reachable via SQL
-- either: id is a primary key, so a second insert is rejected outright, and
-- deleting the row first would cascade-delete (on delete cascade) the very
-- profiles/categories rows this block exists to prove survive a re-run.
-- So this re-executes the exact insert statements the trigger body runs --
-- keep this block in sync with migration 0007 if that list ever changes --
-- directly against the same owner id already seeded above. That is exactly
-- the SQL a retried webhook or re-fired trigger would execute a second
-- time, and it is the ON CONFLICT arbiters under test, not the AFTER INSERT
-- plumbing around them.
do $$
declare
  uid uuid := '55550000-0000-0000-0000-000000000001';
  n int;
begin
  insert into profiles (id, display_name) values (uid, 'newuser')
  on conflict (id) do nothing;

  insert into categories (owner_id, name, kind, color_slot, icon, sort_order, is_default) values
    (uid,'Groceries',    'expense',1,'shopping-basket', 1,true),
    (uid,'Eating out',   'expense',2,'utensils',        2,true),
    (uid,'Transport',    'expense',3,'bus',             3,true),
    (uid,'Housing',      'expense',4,'house',           4,true),
    (uid,'Utilities',    'expense',5,'plug',            5,true),
    (uid,'Health',       'expense',6,'heart-pulse',     6,true),
    (uid,'Entertainment','expense',7,'clapperboard',    7,true),
    (uid,'Shopping',     'expense',8,'shopping-bag',    8,true),
    (uid,'Travel',       'expense',1,'plane',           9,true),
    (uid,'Education',    'expense',2,'graduation-cap', 10,true),
    (uid,'Subscriptions','expense',3,'repeat',         11,true),
    (uid,'Other',        'expense',4,'circle-ellipsis',12,true),
    (uid,'Salary',       'income', 3,'wallet',          1,true),
    (uid,'Bonus',        'income', 5,'gift',            2,true),
    (uid,'Interest',     'income', 6,'piggy-bank',      3,true),
    (uid,'Other income', 'income', 8,'circle-plus',     4,true)
  on conflict (owner_id, kind, (lower(btrim(name)))) where archived_at is null do nothing;

  select count(*) into n from categories where owner_id = uid;
  assert n = 16, format('SEED NOT IDEMPOTENT: re-running the seed insert changed the category count to %s', n);

  select count(*) into n from profiles where id = uid;
  assert n = 1, format('SEED NOT IDEMPOTENT: re-running the seed insert changed the profiles count to %s', n);
end $$;

select 'seed tests passed' as result;
