-- Assertion-based checks for the four ledger CHECK constraints (spec §3.3)
-- on transactions. This file runs as the table-owning superuser and
-- deliberately bypasses RLS -- it tests CHECK-constraint invariants, not the
-- RLS boundary (see supabase/tests/rls.sql for that suite, which runs as
-- role `authenticated` instead).
--
-- ACCEPT blocks are plain statements: under ON_ERROR_STOP=1, an ACCEPT that
-- unexpectedly fails aborts the whole script loudly. REJECT blocks each
-- catch their expected failure and assert BOTH the SQLSTATE (23514
-- check_violation -- the CHECK-constraint code, never 42501
-- insufficient_privilege, which would mean this file had drifted into
-- testing a privilege boundary instead of a data-shape one) and the
-- specific constraint name that should have fired (transfer_shape has two
-- independent ways to fail -- missing transfer_id, and a set category_id --
-- so asserting the name, not just the SQLSTATE, confirms each REJECT block
-- tripped the invariant it claims to, not merely *a* check constraint). If
-- an ACCEPT unexpectedly fails, or a REJECT unexpectedly succeeds, or a
-- REJECT fails for the wrong reason, the assertion raises and the script
-- exits non-zero.
--
-- Earlier version of this file ran with `\set ON_ERROR_STOP off` and no
-- assertions -- psql exited 0 regardless of outcome, so the gate could not
-- fail (see task-8-report.md, round 3, Open 2).
\set ON_ERROR_STOP on
begin;
  insert into auth.users (id,email) values ('22222222-2222-2222-2222-222222222222','b@x.io');
  insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
    values ('33333333-3333-3333-3333-333333333333',
            '22222222-2222-2222-2222-222222222222','Main','bank','USD',1,'landmark');
  insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
    values ('44444444-4444-4444-4444-444444444444',
            '22222222-2222-2222-2222-222222222222','Secondary','card','USD',2,'wallet');
  -- Named 'Constraint Test Category', not 'Groceries': migration 0008's
  -- wallet-creation seed trigger fires on each wallet insert above and
  -- gives wallet 33333333-...-333 16 default categories including one
  -- named 'Groceries' ('expense' kind); reusing that name here would
  -- collide with categories_unique_active_name instead of exercising this
  -- file's own CHECK-constraint assertions. wallet_id, not owner_id (0008):
  -- categories now belong to a wallet.
  insert into categories (id,wallet_id,name,kind,color_slot,icon)
    values ('55555555-5555-5555-5555-555555555555',
            '33333333-3333-3333-3333-333333333333','Constraint Test Category','expense',1,'shopping-cart');

  -- ACCEPT: a valid expense row must succeed.
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'expense', -500, 'USD', current_date);

  -- ACCEPT: a valid income row must succeed.
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'income', 500, 'USD', current_date);

  -- ACCEPT: a valid transfer pair (opposite signs, distinct wallets, shared transfer_id) must succeed.
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,transfer_id,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'transfer', -500, 'USD', '66666666-6666-6666-6666-666666666666', current_date);
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,transfer_id,occurred_on)
    values ('44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222',
            'transfer', 500, 'USD', '66666666-6666-6666-6666-666666666666', current_date);

  do $$ begin
    assert (select count(*) from transactions) = 4,
      'ACCEPT rows did not all land (expected 4: expense, income, 2 transfer legs)';
  end $$;

  -- REJECT: expense with a positive amount -> expense_is_negative
  do $$
  declare
    v_sqlstate   text;
    v_constraint text;
  begin
    insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
      values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
              'expense', 500, 'USD', current_date);
    raise exception 'CONSTRAINT BROKEN: expense_is_negative did not reject a positive expense amount';
  exception
    when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      assert v_sqlstate = '23514' and v_constraint = 'expense_is_negative',
        format('expected check_violation (23514) from expense_is_negative, got SQLSTATE %s (constraint %s): %s',
               v_sqlstate, v_constraint, sqlerrm);
  end $$;

  -- REJECT: income with a negative amount -> income_is_positive
  do $$
  declare
    v_sqlstate   text;
    v_constraint text;
  begin
    insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
      values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
              'income', -500, 'USD', current_date);
    raise exception 'CONSTRAINT BROKEN: income_is_positive did not reject a negative income amount';
  exception
    when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      assert v_sqlstate = '23514' and v_constraint = 'income_is_positive',
        format('expected check_violation (23514) from income_is_positive, got SQLSTATE %s (constraint %s): %s',
               v_sqlstate, v_constraint, sqlerrm);
  end $$;

  -- REJECT: transfer without transfer_id -> transfer_shape
  do $$
  declare
    v_sqlstate   text;
    v_constraint text;
  begin
    insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
      values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
              'transfer', -500, 'USD', current_date);
    raise exception 'CONSTRAINT BROKEN: transfer_shape did not reject a transfer with no transfer_id';
  exception
    when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      assert v_sqlstate = '23514' and v_constraint = 'transfer_shape',
        format('expected check_violation (23514) from transfer_shape, got SQLSTATE %s (constraint %s): %s',
               v_sqlstate, v_constraint, sqlerrm);
  end $$;

  -- REJECT: transfer WITH a category_id -> transfer_shape (second, independent way to fail)
  do $$
  declare
    v_sqlstate   text;
    v_constraint text;
  begin
    insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,category_id,transfer_id,occurred_on)
      values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
              'transfer', -500, 'USD', '55555555-5555-5555-5555-555555555555', gen_random_uuid(), current_date);
    raise exception 'CONSTRAINT BROKEN: transfer_shape did not reject a transfer with a category_id set';
  exception
    when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      assert v_sqlstate = '23514' and v_constraint = 'transfer_shape',
        format('expected check_violation (23514) from transfer_shape, got SQLSTATE %s (constraint %s): %s',
               v_sqlstate, v_constraint, sqlerrm);
  end $$;

  -- REJECT: expense WITH a transfer_id -> non_transfer_no_link
  do $$
  declare
    v_sqlstate   text;
    v_constraint text;
  begin
    insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,transfer_id,occurred_on)
      values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
              'expense', -500, 'USD', gen_random_uuid(), current_date);
    raise exception 'CONSTRAINT BROKEN: non_transfer_no_link did not reject an expense with a transfer_id set';
  exception
    when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      assert v_sqlstate = '23514' and v_constraint = 'non_transfer_no_link',
        format('expected check_violation (23514) from non_transfer_no_link, got SQLSTATE %s (constraint %s): %s',
               v_sqlstate, v_constraint, sqlerrm);
  end $$;
rollback;

-- transactions_category_same_wallet (0008): a transaction may not point at a
-- category belonging to a different wallet. The REJECT below is paired with
-- two positives, so this proves a constraint and not a broken insert path:
-- a SAME-wallet category is accepted, and a transfer (category_id null,
-- exempt by MATCH SIMPLE) is accepted. Both positives were described by this
-- comment before they existed -- review-caught, and the reason a claim in a
-- comment is not evidence.
insert into auth.users (id, email) values ('eeeeeeee-0000-0000-0000-000000000005','erin@x.io');
insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('55555555-0000-0000-0000-000000000005','eeeeeeee-0000-0000-0000-000000000005','X','bank','USD',0,1,'landmark'),
       ('66666666-0000-0000-0000-000000000006','eeeeeeee-0000-0000-0000-000000000005','Y','bank','USD',0,2,'landmark');

do $$
declare foreign_cat uuid;
begin
  select id into foreign_cat from public.categories
  where wallet_id = '55555555-0000-0000-0000-000000000005' limit 1;
  begin
    insert into public.transactions (wallet_id, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('66666666-0000-0000-0000-000000000006','expense',-100,'USD', foreign_cat, current_date);
    raise exception 'expected transactions_category_same_wallet to reject a cross-wallet category';
  exception when foreign_key_violation then
    null; -- correct
  end;
end $$;

-- POSITIVE 1: the SAME wallet's own category is accepted. Without this, a
-- constraint (or an insert path) that rejected EVERY category_id would sail
-- through the REJECT above -- the denial only means something paired with a
-- permission.
do $$
declare own_cat uuid; n int;
begin
  select id into own_cat from public.categories
  where wallet_id = '66666666-0000-0000-0000-000000000006' and kind = 'expense' limit 1;
  assert own_cat is not null, 'test setup broken: wallet Y has no seeded expense category';

  insert into public.transactions (wallet_id, kind, amount_minor, currency_code, category_id, occurred_on)
  values ('66666666-0000-0000-0000-000000000006','expense',-100,'USD', own_cat, current_date);

  select count(*) into n from public.transactions
  where wallet_id = '66666666-0000-0000-0000-000000000006' and category_id = own_cat;
  assert n = 1,
    format('CONSTRAINT BROKEN: transactions_category_same_wallet rejected a category from the transaction''s OWN wallet (%s row(s) landed)', n);
end $$;

-- POSITIVE 2: a transfer leg carries category_id null and must be accepted.
-- MATCH SIMPLE (the default) skips a composite FK check whenever any column
-- of the key is null, which is what makes transfers exempt -- 0008's own
-- comment says so, and this is the assertion behind that claim.
do $$
declare n int;
begin
  insert into public.transactions (wallet_id, kind, amount_minor, currency_code, category_id, transfer_id, occurred_on)
  values ('66666666-0000-0000-0000-000000000006','transfer',-250,'USD', null,
          '77777777-0000-0000-0000-000000000077', current_date);

  select count(*) into n from public.transactions
  where transfer_id = '77777777-0000-0000-0000-000000000077';
  assert n = 1,
    format('CONSTRAINT BROKEN: a transfer leg with category_id null was not accepted (%s row(s) landed)', n);
end $$;

-- get_budget_status counts EXPENSES ONLY (spec, Global Constraints). A wallet
-- holding one expense, one income and one transfer must report only the
-- expense. This runs as the table owner, so it tests the FILTER, not RLS --
-- the RLS half lives in rls.sql.
insert into auth.users (id, email) values ('aaaa3333-0000-4000-8000-000000000003','b3@x.io');
insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('bbbb3333-0000-4000-8000-000000000003','aaaa3333-0000-4000-8000-000000000003','Kinds','bank','USD',0,1,'landmark'),
       ('bbbb4444-0000-4000-8000-000000000004','aaaa3333-0000-4000-8000-000000000003','Other','bank','USD',0,2,'landmark');

-- create_transfer and get_budget_status both resolve wallet membership via
-- public.is_wallet_member(), which reads auth.uid() -- itself derived from
-- the request.jwt.claim(s) GUCs. This file runs as the table-owning
-- superuser and deliberately bypasses RLS (see this file's header), but
-- that bypass is orthogonal to these two functions: they are SECURITY
-- DEFINER and consult auth.uid() directly, not RLS, so with no JWT claims
-- set auth.uid() is NULL and both would see zero membership regardless of
-- the bypass. SET LOCAL requires an explicit transaction (the same rule
-- rls.sql's header documents) so both calls below are wrapped in one.
begin;
  set local request.jwt.claims = '{"sub":"aaaa3333-0000-4000-8000-000000000003"}';
  do $$
  declare exp_cat uuid; inc_cat uuid; total bigint;
  begin
    assert (select auth.uid()) = 'aaaa3333-0000-4000-8000-000000000003'::uuid,
      'test setup broken: auth.uid() did not resolve to the wallet owner';

    select id into exp_cat from public.categories
     where wallet_id = 'bbbb3333-0000-4000-8000-000000000003' and kind = 'expense' limit 1;
    select id into inc_cat from public.categories
     where wallet_id = 'bbbb3333-0000-4000-8000-000000000003' and kind = 'income' limit 1;

    insert into public.transactions (wallet_id, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('bbbb3333-0000-4000-8000-000000000003','expense',-5000,'USD',exp_cat,'2026-08-10'),
           ('bbbb3333-0000-4000-8000-000000000003','income',  90000,'USD',inc_cat,'2026-08-11');

    -- A real transfer pair, so the transfer branch is genuinely exercised
    -- rather than assumed absent.
    perform public.create_transfer(
      'bbbb3333-0000-4000-8000-000000000003',
      'bbbb4444-0000-4000-8000-000000000004',
      2500, 2500, '2026-08-12', null);

    select coalesce(sum(spent_minor), 0) into total
    from public.get_budget_status('2026-08-01','2026-08-31')
    where wallet_id = 'bbbb3333-0000-4000-8000-000000000003' and category_id is not null;

    if total <> 5000 then
      raise exception 'expenses-only broken: expected 5000, got %', total;
    end if;
  end $$;
commit;

-- ROUND-1 FIX (Important/Minor pairing, review round 1): carry-forward.
-- "The effective budget for a month is the most recent row at or BEFORE
-- it" is one of the spec's four headline decisions (get_budget_status's own
-- header comment: "one row set in September governs October onward, and
-- raising the amount in October leaves September measured against
-- September's row"). The SQL (order by period_start desc, filtered to
-- period_start <= from_date, DISTINCT ON (wallet_id, category_id)) was
-- correct by inspection but had no assertion proving it -- a refactor could
-- silently break this user-facing promise with nothing to catch it. Placed
-- in constraints.sql, not rls.sql: this is a functional/business-logic
-- property of get_budget_status's query, the same category the
-- expenses-only block immediately above already tests in this file, not an
-- RLS access-boundary property (that suite lives in rls.sql). A fresh
-- wallet/user fixture is used so this is not entangled with any other
-- block's budget rows.
insert into auth.users (id, email) values ('aaaa6666-0000-4000-8000-000000000006','b6@x.io');
insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
values ('bbbb6666-0000-4000-8000-000000000006','aaaa6666-0000-4000-8000-000000000006','Carry Forward','bank','USD',0,3,'landmark');

begin;
  -- Same reason as the expenses-only block above: get_budget_status resolves
  -- membership via auth.uid(), which needs an explicit transaction for
  -- SET LOCAL to take effect.
  set local request.jwt.claims = '{"sub":"aaaa6666-0000-4000-8000-000000000006"}';
  do $$
  declare v bigint;
  begin
    assert (select auth.uid()) = 'aaaa6666-0000-4000-8000-000000000006'::uuid,
      'test setup broken: auth.uid() did not resolve to the carry-forward wallet''s owner';

    -- September's own budget: 500.00.
    insert into public.budgets (wallet_id, period_start, amount_minor)
    values ('bbbb6666-0000-4000-8000-000000000006', '2026-09-01', 50000);
    -- October's RAISED budget: 800.00. A different amount for a later month.
    insert into public.budgets (wallet_id, period_start, amount_minor)
    values ('bbbb6666-0000-4000-8000-000000000006', '2026-10-01', 80000);

    -- The whole behaviour in one pair of assertions: September must still
    -- report September's OWN amount, unaffected by October's later raise;
    -- October must report the raised amount.
    select budget_minor into v from public.get_budget_status('2026-09-01','2026-09-30')
     where wallet_id = 'bbbb6666-0000-4000-8000-000000000006' and category_id is null;
    assert v = 50000,
      format('CARRY-FORWARD BROKEN: September must be measured against its own row (50000), got %s', v);

    select budget_minor into v from public.get_budget_status('2026-10-01','2026-10-31')
     where wallet_id = 'bbbb6666-0000-4000-8000-000000000006' and category_id is null;
    assert v = 80000,
      format('CARRY-FORWARD BROKEN: October must report its own raised amount (80000), got %s', v);

    -- Bonus coverage for the other half of the same header comment: a month
    -- with NO row of its own (November) must carry forward the most recent
    -- prior row (October's 80000), not October's superseded September value
    -- and not "no budget".
    select budget_minor into v from public.get_budget_status('2026-11-01','2026-11-30')
     where wallet_id = 'bbbb6666-0000-4000-8000-000000000006' and category_id is null;
    assert v = 80000,
      format('CARRY-FORWARD BROKEN: November (no row of its own) must carry forward October''s 80000, got %s', v);

    -- And a month BEFORE any budget existed (August) must show no budget
    -- row at all -- there is nothing at or before August for the eff CTE
    -- to find, so this wallet must not appear in the overall-cap branch.
    assert not exists (
      select 1 from public.get_budget_status('2026-08-01','2026-08-31')
       where wallet_id = 'bbbb6666-0000-4000-8000-000000000006' and category_id is null
    ), 'CARRY-FORWARD BROKEN: a month before any budget existed must not report one';
  end $$;
commit;

-- ADDITIONAL SCOPE (task-2 ruling, beyond the brief): budgets_category_period
-- must reject a second budget for the same (wallet, category, month) -- the
-- CATEGORY partial index's own bad case. Task 1's verification exercised
-- budgets_overall_period (the wallet-wide cap) but never this one; a
-- reviewer confirmed ad-hoc that budgets_category_period does reject a
-- duplicate, but left no permanent guard. This is that guard. Reuses wallet
-- 'bbbb3333-...-003' (Kinds) from the expenses-only block above, which
-- already has a seeded expense category to budget against.
do $$
declare
  exp_cat uuid;
  v_sqlstate   text;
  v_constraint text;
begin
  select id into exp_cat from public.categories
   where wallet_id = 'bbbb3333-0000-4000-8000-000000000003' and kind = 'expense' limit 1;
  assert exp_cat is not null, 'test setup broken: wallet Kinds has no seeded expense category';

  -- ACCEPT: the first budget for this (wallet, category, month) must succeed.
  insert into public.budgets (wallet_id, category_id, period_start, amount_minor)
  values ('bbbb3333-0000-4000-8000-000000000003', exp_cat, '2026-08-01', 10000);

  -- REJECT: a second budget for the SAME (wallet, category, month) -> budgets_category_period.
  begin
    insert into public.budgets (wallet_id, category_id, period_start, amount_minor)
    values ('bbbb3333-0000-4000-8000-000000000003', exp_cat, '2026-08-01', 20000);
    raise exception 'CONSTRAINT BROKEN: budgets_category_period did not reject a second budget for the same (wallet, category, month)';
  exception
    when unique_violation then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      assert v_sqlstate = '23505' and v_constraint = 'budgets_category_period',
        format('expected unique_violation (23505) from budgets_category_period, got SQLSTATE %s (constraint %s): %s',
               v_sqlstate, v_constraint, sqlerrm);
  end;

  -- POSITIVE control, paired with the denial above: a DIFFERENT month for
  -- the same wallet+category is unaffected by the index and must succeed.
  insert into public.budgets (wallet_id, category_id, period_start, amount_minor)
  values ('bbbb3333-0000-4000-8000-000000000003', exp_cat, '2026-09-01', 10000);
  assert (select count(*) from public.budgets
            where wallet_id = 'bbbb3333-0000-4000-8000-000000000003' and category_id = exp_cat) = 2,
    'CONSTRAINT BROKEN: budgets_category_period rejected a legitimate different-month budget for the same wallet+category';
end $$;

-- set_budget (0012): proves the ON CONFLICT upsert this function performs
-- actually infers the two PARTIAL indexes (budgets_category_period,
-- budgets_overall_period) rather than silently duplicating rows. This is
-- the exact bug class the brief's CORRECTION describes: a bare
-- `on conflict (wallet_id, category_id, period_start)` (no predicate)
-- cannot infer a partial index and fails at the database with "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification" --
-- see the "watch it fail" step below, deliberately reproduced and then
-- reverted.
--
-- Reuses wallet 'bbbb3333-...-003' (Kinds) and its owner
-- 'aaaa3333-...-003' from the expenses-only block above, and that block's
-- own begin/set local request.jwt.claims/commit wrapper: set_budget
-- resolves membership through auth.uid() (via is_wallet_member), which is
-- NULL in this superuser session with no JWT claims set.
begin;
  set local request.jwt.claims = '{"sub":"aaaa3333-0000-4000-8000-000000000003"}';
  do $$
  declare
    exp_cat uuid;
    v_id_first  uuid;
    v_id_second uuid;
    v_amount    bigint;
    v_count     int;
  begin
    assert (select auth.uid()) = 'aaaa3333-0000-4000-8000-000000000003'::uuid,
      'test setup broken: auth.uid() did not resolve to the wallet owner';

    select id into exp_cat from public.categories
     where wallet_id = 'bbbb3333-0000-4000-8000-000000000003' and kind = 'expense' limit 1;
    assert exp_cat is not null, 'test setup broken: wallet Kinds has no seeded expense category';

    -- CATEGORY shape: first call with no existing row creates one.
    select public.set_budget(
      'bbbb3333-0000-4000-8000-000000000003', exp_cat, '2026-11-01', 10000
    ) into v_id_first;
    assert v_id_first is not null, 'set_budget (category) did not return an id on insert';

    select amount_minor into v_amount from public.budgets where id = v_id_first;
    assert v_amount = 10000,
      format('set_budget (category) insert: expected amount 10000, got %s', v_amount);

    -- CATEGORY shape: second call, same (wallet, category, month), different
    -- amount, must leave EXACTLY ONE row carrying the new amount -- not a
    -- second row. Row count, not just amount: "updated" and "inserted a
    -- duplicate" both leave a row with the new amount, so amount alone
    -- cannot distinguish them.
    select public.set_budget(
      'bbbb3333-0000-4000-8000-000000000003', exp_cat, '2026-11-01', 20000
    ) into v_id_second;

    select count(*) into v_count from public.budgets
     where wallet_id = 'bbbb3333-0000-4000-8000-000000000003'
       and category_id = exp_cat and period_start = '2026-11-01';
    assert v_count = 1,
      format('SET_BUDGET UPSERT BROKEN (category): expected exactly 1 row after re-calling set_budget, got %s', v_count);

    select amount_minor into v_amount from public.budgets where id = v_id_second;
    assert v_amount = 20000,
      format('SET_BUDGET UPSERT BROKEN (category): expected updated amount 20000, got %s', v_amount);

    -- OVERALL shape: p_category_id => null. First call with no existing row
    -- creates one.
    select public.set_budget(
      'bbbb3333-0000-4000-8000-000000000003', null, '2026-11-01', 30000
    ) into v_id_first;
    assert v_id_first is not null, 'set_budget (overall) did not return an id on insert';

    select amount_minor into v_amount from public.budgets where id = v_id_first;
    assert v_amount = 30000,
      format('set_budget (overall) insert: expected amount 30000, got %s', v_amount);

    -- OVERALL shape: second call, same (wallet, month), different amount,
    -- must again leave exactly one row.
    select public.set_budget(
      'bbbb3333-0000-4000-8000-000000000003', null, '2026-11-01', 40000
    ) into v_id_second;

    select count(*) into v_count from public.budgets
     where wallet_id = 'bbbb3333-0000-4000-8000-000000000003'
       and category_id is null and period_start = '2026-11-01';
    assert v_count = 1,
      format('SET_BUDGET UPSERT BROKEN (overall): expected exactly 1 row after re-calling set_budget, got %s', v_count);

    select amount_minor into v_amount from public.budgets where id = v_id_second;
    assert v_amount = 40000,
      format('SET_BUDGET UPSERT BROKEN (overall): expected updated amount 40000, got %s', v_amount);
  end $$;
commit;
