-- supabase/tests/seed.sql
-- Verifies migration 0007's new-user profile seed and migration 0022's
-- HOUSEHOLD category seed by VALUE, not just count: exactly one profiles row
-- per user, exactly one space with the user as its owner, and sixteen
-- categories in that space that match the brief's rows on kind, name,
-- color_slot and icon -- not merely "16 rows exist" (a count assertion is
-- equally happy if every row were named 'x' with color_slot 1 and an empty
-- icon). Also proves the idempotency the seed trigger's ON CONFLICT DO
-- NOTHING clause exists to provide, and -- 0022's central claim -- that
-- creating a wallet seeds NOTHING, so a second wallet does not mint a second
-- sixteen.
--
-- Under 0008 this file proved the opposite of both: zero categories until
-- the first wallet, and an independent sixteen per wallet. That per-wallet
-- duplication is exactly what 0022 exists to remove, so the assertions here
-- invert rather than merely update.
--
-- Runs as the table-owning superuser, like constraints.sql -- this suite
-- checks the seed triggers' output shape, not the RLS boundary (rls.sql
-- already proves the seeded rows are correctly household-scoped under RLS:
-- visible to the household's members, invisible to an outsider).
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

-- Exactly one household, owned by the new user, named from the email, and
-- ALREADY holding the sixteen defaults before any wallet exists. This is the
-- "category list exists from first login" property 0022 moved the seed up
-- one level to provide.
do $$
declare v_space uuid;
begin
  select space_id into v_space
    from space_members where user_id = '55550000-0000-0000-0000-000000000001';
  assert v_space is not null, 'SEED BROKEN: signup did not put the user in a household';
  assert (select count(*) from space_members where user_id = '55550000-0000-0000-0000-000000000001') = 1,
    'SEED BROKEN: signup put the user in more than one household';
  assert (select role from space_members where user_id = '55550000-0000-0000-0000-000000000001') = 'owner',
    'SEED BROKEN: the user does not own the household signup created for them';
  assert (select name from spaces where id = v_space) = 'newuser household',
    format('SEED BROKEN: household name was not derived from the email local-part (got %s)',
           (select name from spaces where id = v_space));
  assert (select count(*) from categories where space_id = v_space) = 16,
    format('SEED BROKEN: expected 16 categories in a fresh household, got %s',
           (select count(*) from categories where space_id = v_space));
end $$;

-- Tuple-level, on kind, name, color_slot and icon -- a comparison in BOTH
-- directions (nothing extra beyond the brief, nothing missing from it), not
-- a bare count. A wrong icon, a swapped color_slot, or a typo'd name on any
-- single row fails this. Slots run 1..16 since 0022: the palette has had
-- sixteen colours since 0017, and a household's sixteen defaults now take
-- one each rather than wrapping the eight 0008 had to work with.
insert into auth.users (id, email) values ('dddddddd-0000-0000-0000-000000000004','dave@x.io');

do $$
declare
  v_space   uuid;
  n_extra   int;
  n_missing int;
begin
  select space_id into v_space
    from space_members where user_id = 'dddddddd-0000-0000-0000-000000000004';
  assert v_space is not null, 'SEED BROKEN: dave has no household';

  -- Seeded rows that don't match any expected (kind, name, color_slot, icon) tuple.
  select count(*) into n_extra
  from categories c
  where c.space_id = v_space
    and not exists (
      select 1 from (values
        ('expense','Groceries',     1,'shopping-basket'),
        ('expense','Eating out',    2,'utensils'),
        ('expense','Transport',     3,'bus'),
        ('expense','Housing',       4,'house'),
        ('expense','Utilities',     5,'plug'),
        ('expense','Health',        6,'heart-pulse'),
        ('expense','Entertainment', 7,'clapperboard'),
        ('expense','Shopping',      8,'shopping-bag'),
        ('expense','Travel',        9,'plane'),
        ('expense','Education',    10,'graduation-cap'),
        ('expense','Subscriptions',11,'repeat'),
        ('expense','Other',        12,'circle-ellipsis'),
        ('income', 'Salary',       13,'wallet'),
        ('income', 'Bonus',        14,'gift'),
        ('income', 'Interest',     15,'piggy-bank'),
        ('income', 'Other income', 16,'circle-plus')
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
    ('expense','Groceries',     1,'shopping-basket'),
    ('expense','Eating out',    2,'utensils'),
    ('expense','Transport',     3,'bus'),
    ('expense','Housing',       4,'house'),
    ('expense','Utilities',     5,'plug'),
    ('expense','Health',        6,'heart-pulse'),
    ('expense','Entertainment', 7,'clapperboard'),
    ('expense','Shopping',      8,'shopping-bag'),
    ('expense','Travel',        9,'plane'),
    ('expense','Education',    10,'graduation-cap'),
    ('expense','Subscriptions',11,'repeat'),
    ('expense','Other',        12,'circle-ellipsis'),
    ('income', 'Salary',       13,'wallet'),
    ('income', 'Bonus',        14,'gift'),
    ('income', 'Interest',     15,'piggy-bank'),
    ('income', 'Other income', 16,'circle-plus')
  ) as expected(kind, name, color_slot, icon)
  where not exists (
    select 1 from categories c
    where c.space_id = v_space
      and expected.kind::category_kind = c.kind
      and expected.name = c.name
      and expected.color_slot = c.color_slot
      and expected.icon = c.icon
  );
  assert n_missing = 0,
    format('SEED BROKEN: %s of the brief''s 16 categories are missing from the seed', n_missing);
end $$;

-- A wallet seeds NOTHING and lands in its owner's household. Two wallets for
-- the same user share the one list -- there is no "second sixteen". This is
-- the per-wallet duplication 0022 removes, asserted directly.
insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('33333333-0000-0000-0000-000000000003','dddddddd-0000-0000-0000-000000000004','First','bank','USD',0,1,'landmark'),
       ('44444444-0000-0000-0000-000000000004','dddddddd-0000-0000-0000-000000000004','Second','bank','USD',0,2,'landmark');

do $$
declare v_space uuid;
begin
  select space_id into v_space
    from space_members where user_id = 'dddddddd-0000-0000-0000-000000000004';

  assert (select space_id from wallets where id = '33333333-0000-0000-0000-000000000003') = v_space,
    'SEED BROKEN: set_wallet_space did not file the first wallet in its owner''s household';
  assert (select space_id from wallets where id = '44444444-0000-0000-0000-000000000004') = v_space,
    'SEED BROKEN: set_wallet_space did not file the second wallet in its owner''s household';
  assert (select count(*) from categories where space_id = v_space) = 16,
    format('SEED BROKEN: creating two wallets changed the household''s category count to %s -- a wallet must seed nothing',
           (select count(*) from categories where space_id = v_space));
  assert (select count(*) from categories) = 32,
    format('SEED BROKEN: expected exactly 32 categories across two households, got %s',
           (select count(*) from categories));
  -- The owner's own membership row is filled in by wallet_members_set_space
  -- and stays consistent with the wallet it references.
  assert (select count(*) from wallet_members
           where user_id = 'dddddddd-0000-0000-0000-000000000004' and space_id = v_space) = 2,
    'SEED BROKEN: the owner''s wallet_members rows do not carry the wallet''s household';
end $$;

-- Idempotency: ON CONFLICT DO NOTHING on the seed insert in migration
-- 0022's seed_space_categories() is the load-bearing resilience decision
-- (carried over from 0007's handle_new_user() via 0008's
-- seed_wallet_categories()) -- if this trigger raises, signup itself fails,
-- so a retried request or a re-fired trigger for the same space must be a
-- no-op instead of an error.
--
-- seed_space_categories() cannot be invoked directly to prove this
-- ("trigger functions can only be called as triggers"), and genuinely
-- re-firing the AFTER INSERT trigger for the SAME space id is not reachable
-- via SQL either: id is a primary key, so a second insert is rejected
-- outright, and deleting the row first would cascade-delete (on delete
-- cascade) the very categories rows this block exists to prove survive a
-- re-run. So this re-executes the exact insert statement the trigger body
-- runs -- keep this block in sync with migration 0022 if that list ever
-- changes -- directly against dave's already-seeded household. That is
-- exactly the SQL a re-fired trigger would execute a second time, and it is
-- the ON CONFLICT behaviour under test, not the AFTER INSERT plumbing
-- around it.
do $$
declare
  sid uuid;
  n int;
begin
  select space_id into sid
    from space_members where user_id = 'dddddddd-0000-0000-0000-000000000004';

  insert into categories (space_id, name, kind, color_slot, icon, sort_order, is_default) values
    (sid,'Groceries',    'expense', 1,'shopping-basket', 1,true),
    (sid,'Eating out',   'expense', 2,'utensils',        2,true),
    (sid,'Transport',    'expense', 3,'bus',             3,true),
    (sid,'Housing',      'expense', 4,'house',           4,true),
    (sid,'Utilities',    'expense', 5,'plug',            5,true),
    (sid,'Health',       'expense', 6,'heart-pulse',     6,true),
    (sid,'Entertainment','expense', 7,'clapperboard',    7,true),
    (sid,'Shopping',     'expense', 8,'shopping-bag',    8,true),
    (sid,'Travel',       'expense', 9,'plane',           9,true),
    (sid,'Education',    'expense',10,'graduation-cap', 10,true),
    (sid,'Subscriptions','expense',11,'repeat',         11,true),
    (sid,'Other',        'expense',12,'circle-ellipsis',12,true),
    (sid,'Salary',       'income', 13,'wallet',          1,true),
    (sid,'Bonus',        'income', 14,'gift',            2,true),
    (sid,'Interest',     'income', 15,'piggy-bank',      3,true),
    (sid,'Other income', 'income', 16,'circle-plus',     4,true)
  on conflict (space_id, kind, (lower(btrim(name)))) where archived_at is null do nothing;

  select count(*) into n from categories where space_id = sid;
  assert n = 16, format('SEED NOT IDEMPOTENT: re-running the seed insert changed the category count to %s', n);
end $$;

-- One household per signup, every time: a third user gets exactly one, and
-- the total is exactly one per user, so no signup path mints a spare.
-- (handle_new_user's "already has a household" guard cannot be exercised
-- from SQL -- the trigger cannot be re-fired for the same auth.users row --
-- so this pins the count it protects rather than the branch itself.)
insert into auth.users (id, email) values ('55550000-0000-0000-0000-000000000002', 'retry@x.io');
do $$ begin
  assert (select count(*) from space_members where user_id = '55550000-0000-0000-0000-000000000002') = 1,
    'SEED BROKEN: signup created more than one household for one user';
  assert (select count(*) from spaces) = 3,
    format('SEED BROKEN: expected exactly one household per signed-up user (3), got %s', (select count(*) from spaces));
end $$;

select 'seed tests passed' as result;
