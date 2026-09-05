-- supabase/tests/migration_0022.sql
-- Migration-correctness fixture for 0022 and 0023 (design 2026-09-05 §9).
-- Run by scripts/test-migration-0022.sh, which resets the database to 0021,
-- feeds the FIXTURE block below, applies 0022 and then 0023 each in a
-- single transaction, and then feeds the ASSERT block. This file holds both halves, split on the
-- `-- >>> ASSERT` marker, so the data and the claims about it stay in one
-- place and cannot drift apart.
--
-- What it plants, under 0021's one-list-per-wallet model:
--
--   alice  owns A;  bob is a member of A and owns B     -> one component (A,B)
--   carol  owns C, shares nothing                       -> a second component
--
--   A: 'Transport' renamed to 'Public Transport'; 1 txn on it
--   B: 'Transport' kept;                           2 txns on it, 1 rule on it
--   A: 'Groceries' active,                         1 txn
--   B: 'Groceries' ARCHIVED,                       3 txns  (more used, but archived)
--   C: untouched defaults,                         1 txn on 'Groceries'
--
--   budgets (0013's name-keyed shape) over {A,B}:  'groceries', and
--   'therapy' -- a key no category has ever matched
--
-- and what 0022 must therefore do:
--
--   * two spaces, not one and not three
--   * (A,B)'s space keeps BOTH 'Transport' and 'Public Transport' (§2: every
--     distinct name survives), giving 17 categories, not 16 and not 32
--   * exactly one 'Groceries' in (A,B), and it is A's ACTIVE row, even though
--     B's archived copy carried more transactions (§5 step 7)
--   * every transaction and rule still points at a category that exists, and
--     B's three Groceries transactions now point at A's survivor
--   * C's space is untouched: 16 categories, its own transaction intact
--   * (0023) the 'groceries' budget lands on the surviving Groceries id and
--     in (A,B)'s space; the 'therapy' budget gets an ARCHIVED placeholder
--     category of that name rather than becoming an overall cap; budget_
--     wallets carries the space; and category_key is gone
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'alice@x.io'),
  ('b0000000-0000-4000-8000-000000000002', 'bob@x.io'),
  ('c0000000-0000-4000-8000-000000000003', 'carol@x.io');

insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', 'A', 'bank', 'USD', 1, 'landmark'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000002', 'B', 'bank', 'USD', 2, 'landmark'),
  ('cccccccc-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-000000000003', 'C', 'bank', 'USD', 3, 'landmark');

-- bob joins A: the one edge that makes (A,B) a component.
insert into wallet_members (wallet_id, user_id, role)
values ('aaaaaaaa-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000002', 'member');

do $$ begin
  assert (select count(*) from categories) = 48,
    'fixture broken: expected 16 seeded categories per wallet under 0021';
end $$;

update categories set name = 'Public Transport'
 where wallet_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and name = 'Transport';

update categories set archived_at = now()
 where wallet_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and name = 'Groceries';

-- Transactions, each keyed to its own wallet's copy of the category.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
select t.id, t.wallet_id, w.owner_id, 'expense', t.amount, 'USD', c.id, current_date
  from (values
    ('e0000000-0000-4000-8000-000000000001'::uuid, 'aaaaaaaa-0000-4000-8000-00000000000a'::uuid, 'Public Transport', -100),
    ('e0000000-0000-4000-8000-000000000002'::uuid, 'bbbbbbbb-0000-4000-8000-00000000000b'::uuid, 'Transport',        -200),
    ('e0000000-0000-4000-8000-000000000003'::uuid, 'bbbbbbbb-0000-4000-8000-00000000000b'::uuid, 'Transport',        -201),
    ('e0000000-0000-4000-8000-000000000004'::uuid, 'aaaaaaaa-0000-4000-8000-00000000000a'::uuid, 'Groceries',        -300),
    ('e0000000-0000-4000-8000-000000000005'::uuid, 'bbbbbbbb-0000-4000-8000-00000000000b'::uuid, 'Groceries',        -400),
    ('e0000000-0000-4000-8000-000000000006'::uuid, 'bbbbbbbb-0000-4000-8000-00000000000b'::uuid, 'Groceries',        -401),
    ('e0000000-0000-4000-8000-000000000007'::uuid, 'bbbbbbbb-0000-4000-8000-00000000000b'::uuid, 'Groceries',        -402),
    ('e0000000-0000-4000-8000-000000000008'::uuid, 'cccccccc-0000-4000-8000-00000000000c'::uuid, 'Groceries',        -500)
  ) as t(id, wallet_id, cat, amount)
  join wallets w on w.id = t.wallet_id
  join categories c on c.wallet_id = t.wallet_id and c.name = t.cat;

insert into recurring_rules (id, wallet_id, created_by, name, kind, amount_minor, currency_code, category_id, interval_unit, anchor_on)
select 'f0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b',
       'b0000000-0000-4000-8000-000000000002', 'Bus pass', 'expense', -5000, 'USD', c.id, 'monthly', current_date
  from categories c
 where c.wallet_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and c.name = 'Transport';

-- Name-keyed budgets, as 0013 stored them. Inserted directly: budgets
-- INSERT is revoked from authenticated but this runs as the owner.
insert into budgets (id, created_by, currency_code, category_key, period_start, amount_minor) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'USD', 'groceries', '2026-09-01', 50000),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'USD', 'therapy',   '2026-09-01', 20000),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'USD', null,        '2026-09-01', 90000);
insert into budget_wallets (budget_id, wallet_id) values
  ('b0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b'),
  ('b0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('b0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a');

do $$ begin
  assert (select count(*) from transactions where category_id is not null) = 8,
    'fixture broken: not every transaction found its category';
  assert (select count(*) from recurring_rules) = 1, 'fixture broken: the rule was not planted';
  assert (select count(*) from budgets) = 3, 'fixture broken: the budgets were not planted';
end $$;

-- >>> ASSERT
\set ON_ERROR_STOP on

do $$
declare
  s_ab uuid; s_c uuid;
  groc uuid;
begin
  -- Components -> spaces.
  assert (select count(*) from spaces) = 2,
    format('0022 BROKEN: expected 2 spaces (one per component), got %s', (select count(*) from spaces));
  select space_id into s_ab from wallets where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
  select space_id into s_c  from wallets where id = 'cccccccc-0000-4000-8000-00000000000c';
  assert (select space_id from wallets where id = 'bbbbbbbb-0000-4000-8000-00000000000b') = s_ab,
    '0022 BROKEN: wallets sharing a member did not land in one space';
  assert s_c <> s_ab, '0022 BROKEN: a wallet sharing no member was merged into another household';

  -- Membership derived, nobody gained or lost reach.
  assert (select array_agg(user_id::text order by user_id) from space_members where space_id = s_ab)
       = array['a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002'],
    '0022 BROKEN: (A,B) space membership is not exactly alice and bob';
  assert (select array_agg(user_id::text) from space_members where space_id = s_c)
       = array['c0000000-0000-4000-8000-000000000003'],
    '0022 BROKEN: C''s space membership is not exactly carol';
  assert (select count(*) from wallet_members m join wallets w on w.id = m.wallet_id where m.space_id <> w.space_id) = 0,
    '0022 BROKEN: a wallet_members row carries a space other than its wallet''s';

  -- Every distinct name survives; exact duplicates merge.
  -- ACTIVE rows only: 0023 (asserted below) adds one ARCHIVED placeholder
  -- for the 'therapy' budget key, which is not part of the merge's result.
  assert (select count(*) from categories where space_id = s_ab and archived_at is null) = 17,
    format('0022 BROKEN: expected 17 active categories in (A,B) (16 shared names + Public Transport), got %s',
           (select count(*) from categories where space_id = s_ab and archived_at is null));
  assert (select count(*) from categories where space_id = s_ab and name = 'Transport') = 1,
    '0022 BROKEN: ''Transport'' did not survive the merge';
  assert (select count(*) from categories where space_id = s_ab and name = 'Public Transport') = 1,
    '0022 BROKEN: ''Public Transport'' was folded away rather than kept';
  assert (select count(*) from categories where space_id = s_c) = 16,
    '0022 BROKEN: the unrelated household''s category list changed';
  assert (select count(*) from categories where name = 'Groceries' and space_id = s_ab) = 1,
    '0022 BROKEN: two Groceries rows survived in one household';

  -- Active beats archived, regardless of usage.
  select id into groc from categories where space_id = s_ab and name = 'Groceries';
  assert (select archived_at from categories where id = groc) is null,
    '0022 BROKEN: the archived Groceries (more used) won over the active one';

  -- Repointing: nothing orphaned, and the losers'' rows now sit on the winner.
  assert (select count(*) from transactions t left join categories c on c.id = t.category_id
           where t.category_id is not null and c.id is null) = 0,
    '0022 BROKEN: a transaction references a category the merge deleted';
  assert (select count(*) from transactions where category_id = groc) = 4,
    format('0022 BROKEN: expected 4 transactions on the surviving Groceries (1 from A + 3 from B), got %s',
           (select count(*) from transactions where category_id = groc));
  assert (select category_id from recurring_rules where id = 'f0000000-0000-4000-8000-000000000001')
       = (select id from categories where space_id = s_ab and name = 'Transport'),
    '0022 BROKEN: the recurring rule was not repointed onto the surviving Transport';
  assert (select count(*) from transactions where category_id =
            (select id from categories where space_id = s_ab and name = 'Public Transport')) = 1,
    '0022 BROKEN: the Public Transport transaction moved';
  assert (select count(*) from transactions where category_id =
            (select id from categories where space_id = s_c and name = 'Groceries')) = 1,
    '0022 BROKEN: C''s transaction moved off its own Groceries';

  -- The denormalised space on every dependant agrees with its wallet.
  assert (select count(*) from transactions t join wallets w on w.id = t.wallet_id where t.space_id <> w.space_id) = 0,
    '0022 BROKEN: a transaction''s space_id disagrees with its wallet''s';
  assert (select count(*) from recurring_rules r join wallets w on w.id = r.wallet_id where r.space_id <> w.space_id) = 0,
    '0022 BROKEN: a rule''s space_id disagrees with its wallet''s';

  -- The old column and the seed-per-wallet trigger are gone.
  assert not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'categories' and column_name = 'wallet_id'),
    '0022 BROKEN: categories.wallet_id still exists';
  assert not exists (select 1 from pg_trigger where tgname = 'wallets_seed_categories'),
    '0022 BROKEN: the per-wallet seed trigger still exists';
end $$;

-- 0023: budgets keyed by name are keyed by id.
do $$
declare s_ab uuid; groc uuid; therapy uuid;
begin
  select space_id into s_ab from wallets where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
  select id into groc from categories where space_id = s_ab and name = 'Groceries';

  assert not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'budgets' and column_name = 'category_key'),
    '0023 BROKEN: budgets.category_key still exists';
  assert (select count(*) from budgets) = 3, '0023 BROKEN: a budget was lost in the conversion';
  assert (select count(*) from budgets where space_id = s_ab) = 3,
    '0023 BROKEN: a budget did not land in its wallet set''s household';

  assert (select category_id from budgets where id = 'b0000000-0000-4000-8000-000000000001') = groc,
    '0023 BROKEN: the ''groceries'' budget was not repointed at the surviving Groceries';
  assert (select category_id from budgets where id = 'b0000000-0000-4000-8000-000000000003') is null,
    '0023 BROKEN: the overall cap gained a category';

  -- The unmatched key: an archived placeholder, NOT a silent overall cap.
  select category_id into therapy from budgets where id = 'b0000000-0000-4000-8000-000000000002';
  assert therapy is not null,
    '0023 BROKEN: a budget over a vanished category became an overall cap (category_id null)';
  assert (select name from categories where id = therapy) = 'therapy',
    '0023 BROKEN: the placeholder category does not carry the old key as its name';
  assert (select archived_at from categories where id = therapy) is not null,
    '0023 BROKEN: the placeholder category is active and would appear in pickers';
  assert (select space_id from categories where id = therapy) = s_ab,
    '0023 BROKEN: the placeholder category is in the wrong household';
  assert (select count(*) from categories where space_id = s_ab) = 18,
    format('0023 BROKEN: expected exactly one placeholder on top of the 17 merged rows, got %s in total',
           (select count(*) from categories where space_id = s_ab));

  assert (select count(*) from budget_wallets where space_id is null) = 0,
    '0023 BROKEN: budget_wallets.space_id was not backfilled';
  assert (select count(*) from budget_wallets bw join wallets w on w.id = bw.wallet_id where bw.space_id <> w.space_id) = 0,
    '0023 BROKEN: a budget_wallets row carries a space other than its wallet''s';
end $$;

select 'migration 0022/0023 tests passed' as result;
