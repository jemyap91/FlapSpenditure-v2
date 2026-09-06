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
  ('c5c50000-0000-4000-8000-0000000000e1', 'c5c50000-0000-4000-8000-0000000000b1', 'c5c50000-0000-4000-8000-000000000002', 'expense', -100, 'USD',
    (select id from categories where name = 'Groceries' and space_id = (select space_id from wallets where id = 'c5c50000-0000-4000-8000-0000000000aa')), current_date),
  ('c5c50000-0000-4000-8000-0000000000e2', 'c5c50000-0000-4000-8000-0000000000b1', 'c5c50000-0000-4000-8000-000000000002', 'expense', -200, 'USD',
    'c5c50000-0000-4000-8000-0000000000c1', current_date),
  ('c5c50000-0000-4000-8000-0000000000e3', 'c5c50000-0000-4000-8000-0000000000b2', 'c5c50000-0000-4000-8000-000000000002', 'expense', -300, 'USD',
    null, current_date),
  ('c5c50000-0000-4000-8000-0000000000e4', 'c5c50000-0000-4000-8000-0000000000aa', 'c5c50000-0000-4000-8000-000000000002', 'expense', -400, 'USD',
    'c5c50000-0000-4000-8000-0000000000c1', current_date);
insert into recurring_rules (id, wallet_id, created_by, name, kind, amount_minor, currency_code, category_id, interval_unit, anchor_on)
values ('c5c50000-0000-4000-8000-0000000000f1', 'c5c50000-0000-4000-8000-0000000000b1', 'c5c50000-0000-4000-8000-000000000002',
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
  assert (select space_id from transactions where id = 'c5c50000-0000-4000-8000-0000000000e3') = s_new, 'LEAVE BROKEN: the uncategorised txn did not move';
  assert (select category_id from transactions where id = 'c5c50000-0000-4000-8000-0000000000e2') = bikes_new, 'LEAVE BROKEN: t2 is not on the new Bikes';
  assert (select category_id from recurring_rules where id = 'c5c50000-0000-4000-8000-0000000000f1') = bikes_new
     and (select space_id from recurring_rules where id = 'c5c50000-0000-4000-8000-0000000000f1') = s_new, 'LEAVE BROKEN: the rule did not move';

  -- The txn mate recorded in W shared stays, attributed to mate.
  assert (select wallet_id from transactions where id = 'c5c50000-0000-4000-8000-0000000000e4') = 'c5c50000-0000-4000-8000-0000000000aa'
     and (select created_by from transactions where id = 'c5c50000-0000-4000-8000-0000000000e4') = 'c5c50000-0000-4000-8000-000000000002',
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
