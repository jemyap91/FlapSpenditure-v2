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

-- Budgets (0013). 0012's budgets/get_budget_status tests are gone with the
-- table. NOTE the direction of that fact, corrected after an earlier draft
-- of this comment got it backwards: get_budget_status was NOT reached by
-- `drop table budgets cascade` -- Postgres does not track a dependency on a
-- table referenced only inside a PL/pgSQL function body, so CASCADE alone
-- left it (and set_budget) present and silently broken against the new
-- columns. 0013 drops both explicitly, for exactly that reason (see its own
-- comment). 0012's category_id/wallet_id-keyed rows no longer match this
-- shape either way. Task 2 recreates get_budget_status and its coverage;
-- this file only proves the CHECK/FK invariants 0013 itself adds, per this
-- file's own header (table-owning superuser, RLS bypassed by design -- the
-- membership boundary is rls.sql's job, not this file's).
--
-- Fixtures: Alice and one of her wallets, using the ids the other suites
-- (rls.sql) already use for the same actor, so a reader cross-referencing
-- fixture ids across files finds the same person and wallet in both.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@x.io');
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
  values ('cccccccc-0000-0000-0000-000000000003',
          'aaaaaaaa-0000-0000-0000-000000000001', 'Alice Bank', 'bank', 'USD', 1, 'landmark');

-- period_start must be the first of a month
do $$
declare v_constraint text;
begin
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', 'groceries', '2026-11-15', 50000);
    raise exception 'CONSTRAINT BROKEN: budgets accepted a mid-month period_start';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    assert v_constraint = 'budgets_period_start_check',
      format('wrong constraint fired: %s', v_constraint);
  end;
end $$;

-- amount_minor must be positive: zero and negative. m8 fix round: name-blind
-- `then null` catches were load-bearing today but silent if a second CHECK
-- were ever added to the column -- assert the specific constraint name, the
-- same discipline guard 1 above and this file's own header both require.
do $$
declare v_constraint text;
begin
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', 'groceries', '2026-11-01', 0);
    raise exception 'CONSTRAINT BROKEN: budgets accepted a zero amount';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    assert v_constraint = 'budgets_amount_minor_check',
      format('wrong constraint fired (zero): %s', v_constraint);
  end;
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', 'groceries', '2026-11-01', -100);
    raise exception 'CONSTRAINT BROKEN: budgets accepted a negative amount';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    assert v_constraint = 'budgets_amount_minor_check',
      format('wrong constraint fired (negative): %s', v_constraint);
  end;
end $$;

-- budget_wallets rejects a wallet that does not exist, and cascades on delete
do $$
declare v_budget uuid; v_rows int; v_constraint text;
begin
  insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', 'groceries', '2026-11-01', 50000)
  returning id into v_budget;

  begin
    insert into public.budget_wallets (budget_id, wallet_id)
    values (v_budget, '00000000-0000-0000-0000-0000000000ff');
    raise exception 'CONSTRAINT BROKEN: budget_wallets accepted a nonexistent wallet';
  exception when foreign_key_violation then
    -- m8 fix round: name the constraint, not just the SQLSTATE class --
    -- budget_wallets has two FKs (budget_id, wallet_id) and this insert
    -- supplies a valid budget_id, so asserting the name confirms THIS is
    -- the one that fired, not a coincidental failure on the other.
    get stacked diagnostics v_constraint = constraint_name;
    assert v_constraint = 'budget_wallets_wallet_id_fkey',
      format('wrong constraint fired: %s', v_constraint);
  end;

  insert into public.budget_wallets (budget_id, wallet_id)
  values (v_budget, 'cccccccc-0000-0000-0000-000000000003');

  delete from public.budgets where id = v_budget;
  select count(*) into v_rows from public.budget_wallets where budget_id = v_budget;
  assert v_rows = 0, 'CASCADE BROKEN: budget_wallets rows survived their budget';
end $$;

-- budgets_currency_code_fkey (I4 fix round): a budget may not carry a
-- currency no wallet could ever have. Matches the ACCEPT/REJECT pairing this
-- file uses throughout -- the REJECT alone would not prove the FK is scoped
-- to exactly the currency column, so a legitimate currency is proven
-- separately (every other block in this file already inserts with 'SGD').
do $$
declare v_constraint text;
begin
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'ZZZ', 'groceries', '2026-11-01', 50000);
    raise exception 'CONSTRAINT BROKEN: budgets accepted a currency_code with no matching currency';
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
    assert v_constraint = 'budgets_currency_code_fkey',
      format('wrong constraint fired: %s', v_constraint);
  end;
end $$;

-- budgets_category_key_check (I6 fix round): the comment on the column
-- promises `lower(btrim(name))`, or NULL for the overall cap. A CHECK is
-- satisfied by NULL -- proven here, not assumed -- and a value that isn't
-- already normalised (leading/trailing space, wrong case) or is empty must
-- be rejected, or the next task's join against categories.name would miss
-- rows silently instead of failing loudly.
do $$
declare v_constraint text; v_id uuid;
begin
  -- ACCEPT: NULL (the overall cap) must not trip the CHECK.
  insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', null, '2026-12-01', 50000)
  returning id into v_id;
  assert v_id is not null, 'CONSTRAINT BROKEN: budgets_category_key_check rejected a NULL category_key (the overall cap)';

  -- REJECT: not already lower(btrim(...)) -- mixed case and untrimmed space.
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', ' Groceries ', '2026-12-01', 50000);
    raise exception 'CONSTRAINT BROKEN: budgets accepted a non-normalised category_key';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    assert v_constraint = 'budgets_category_key_check',
      format('wrong constraint fired (non-normalised): %s', v_constraint);
  end;

  -- REJECT: the empty string, distinct from NULL but equally meaningless.
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', '', '2026-12-01', 50000);
    raise exception 'CONSTRAINT BROKEN: budgets accepted an empty-string category_key';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    assert v_constraint = 'budgets_category_key_check',
      format('wrong constraint fired (empty string): %s', v_constraint);
  end;
end $$;

-- set_budget (0013, Task 3). This file runs entirely as the table-owning
-- superuser (see the header comment), so auth.uid() -- which set_budget
-- consults for membership (via is_wallet_member) and for created_by -- would
-- otherwise be NULL throughout. Wrapped in its own begin/set local
-- request.jwt.claims/commit, exactly as the controller addendum for this
-- task requires, so auth.uid() resolves to a real user for the whole block.
--
-- This is NOT a substitute for supabase/tests/rls.sql's coverage of the same
-- function: set_budget is SECURITY DEFINER and bypasses RLS entirely, so
-- impersonation here only fixes auth.uid() -- it does not exercise the RLS
-- boundary at all (there isn't one left to exercise for this function). The
-- membership/currency/empty-set guards below are the function's OWN checks,
-- which is exactly why this file -- which tests invariants directly, not
-- through RLS -- is where they belong; rls.sql separately proves a
-- REAL member/non-member distinction using genuine wallet_members rows and
-- impersonated callers.
--
-- Fixtures: a second user (Carol) and five wallets -- two of Alice's
-- sharing one currency (for the positive/duplicate/overlap cases), one
-- more of Alice's in a different currency (for the mixed-currency REJECT),
-- one wallet Alice does NOT belong to (Carol's, for the membership
-- REJECT), and a fifth of Alice's that is ARCHIVED after creation (fix
-- round 2, item 1 -- the archived-wallet REJECT below).
insert into auth.users (id, email) values
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'carol@x.io');
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('cccccccc-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-000000000001', 'SB Wallet A', 'bank', 'SGD', 1, 'landmark'),
  ('cccccccc-0000-0000-0000-0000000000b2', 'aaaaaaaa-0000-0000-0000-000000000001', 'SB Wallet B', 'bank', 'SGD', 2, 'wallet'),
  ('cccccccc-0000-0000-0000-0000000000b3', 'aaaaaaaa-0000-0000-0000-000000000001', 'SB Wallet EUR', 'bank', 'EUR', 3, 'euro'),
  ('cccccccc-0000-0000-0000-0000000000b4', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'Carol Wallet', 'bank', 'SGD', 1, 'landmark'),
  ('cccccccc-0000-0000-0000-0000000000b5', 'aaaaaaaa-0000-0000-0000-000000000001', 'SB Wallet Archived', 'bank', 'SGD', 4, 'landmark');
update wallets set archived_at = now() where id = 'cccccccc-0000-0000-0000-0000000000b5';

begin;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'impersonation failed: auth.uid() did not resolve to alice';
  end $$;

  -- REJECT 1, 2, 3 below each use a nested begin/exception, NOT the
  -- "raise exception ... ; exception when others" idiom this file's earlier
  -- CHECK-constraint blocks use: those work because `when check_violation`
  -- (a SPECIFIC condition) does not catch the deliberately-raised
  -- top-level "CONSTRAINT BROKEN" (default SQLSTATE P0001), so an
  -- unexpectedly-successful statement propagates and aborts the script
  -- loudly. set_budget's guards all raise plain `raise exception` with no
  -- distinct SQLSTATE, so `when others` here WOULD also catch a
  -- deliberately-raised "GUARD BROKEN" and mask it behind a merely-wrong
  -- error-message assertion instead of the intended one. Structuring each
  -- block as an inner begin/exception around ONLY the call, setting a flag
  -- on success, and asserting the flag is still false afterward avoids that
  -- trap entirely.

  -- REJECT 1: an empty wallet array must be refused (the fails-open case
  -- this whole branch has been fighting -- see the guard's own comment in
  -- 0013).
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('groceries', '2026-11-01', 50000, array[]::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'a budget must cover at least one account',
        format('wrong error for empty array: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget accepted an empty wallet array';
  end $$;

  -- REJECT 2: a set mixing two currencies must be refused.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('groceries', '2026-11-01', 50000,
        array['cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-0000000000b3']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'every account in a budget must use the same currency',
        format('wrong error for mixed currency: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget accepted a mixed-currency wallet set';
  end $$;

  -- REJECT 3: a set containing a wallet the caller is not a member of must
  -- be refused. cccccccc-...-b4 is Carol's; alice has no membership row on
  -- it at all. This is the guard that matters most (the controller
  -- addendum's own words): the only thing standing between a caller and
  -- every wallet in the database now that set_budget runs with owner rights.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('groceries', '2026-11-01', 50000,
        array['cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-0000000000b4']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'not a member of every account in that set',
        format('wrong error for non-member wallet: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget accepted a wallet alice is not a member of';
  end $$;

  -- REJECT 3b (REVIEW FINDING C1, CRITICAL): the SAME denial as REJECT 3,
  -- submitted as a doubly-nested array literal instead of a flat one.
  -- array_length(p_wallet_ids, 1) measures only the array's first
  -- dimension, so a '{{...}}' literal (one row of two columns, not two
  -- rows) made the OLD membership guard undercount -- while `= any(...)`
  -- and unnest() both still traverse every element regardless of
  -- dimensionality. This was proven, before the fix, to reach set_budget
  -- over real PostgREST with an ordinary authenticated JWT in three
  -- independent encodings (nested JSON array, raw '{{...}}' literal, and
  -- Prefer: params=single-object) and let a partial member both INSERT and
  -- silently UPDATE a budget over a wallet set she did not fully belong to.
  -- REJECT 3 alone (the flat form) does NOT exercise this path -- it is
  -- exactly why every test written before this review passed against the
  -- broken guard.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('groceries', '2026-11-01', 50000,
        '{{cccccccc-0000-0000-0000-0000000000b1,cccccccc-0000-0000-0000-0000000000b4}}'::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'not a member of every account in that set',
        format('wrong error for nested-array non-member wallet: %s', sqlerrm);
    end;
    assert not v_ok,
      'C1 CRITICAL: set_budget accepted a NESTED array containing a wallet alice is not a member of';
  end $$;

  -- FIX ROUND 2, ITEM 1a: a budget may not cover an archived wallet (guard
  -- M5, placed after the membership check in 0013 since only wallets
  -- already proven to be alice's own may be probed for archived status).
  -- cccccccc-...-b5 was archived immediately after creation, above.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('groceries', '2026-11-01', 50000,
        array['cccccccc-0000-0000-0000-0000000000b5']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'an archived account cannot be part of a budget',
        format('wrong error for archived wallet: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget accepted a budget over an archived wallet';
  end $$;

  -- FIX ROUND 2, ITEM 1b: p_period_start must be the first of a month.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('groceries', '2026-11-15', 50000,
        array['cccccccc-0000-0000-0000-0000000000b1']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'a budget period must start on the first of a month',
        format('wrong error for non-month-start period_start: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget accepted a period_start that is not the first of a month';
  end $$;

  -- FIX ROUND 2, ITEM 1c: p_category_key normalisation (lower(btrim(...))).
  -- A category submitted with mixed case and surrounding whitespace must be
  -- stored canonically, so that a later call differing only in case/
  -- whitespace matches this same budget rather than silently creating a
  -- second one.
  do $$
  declare v_id uuid; v_key text;
  begin
    v_id := set_budget('  GroCERies  ', '2026-11-01', 50000,
      array['cccccccc-0000-0000-0000-0000000000b1']::uuid[]);
    select category_key into v_key from public.budgets where id = v_id;
    assert v_key = 'groceries',
      format('NORMALISATION BROKEN: expected category_key ''groceries'', found %L', v_key);
  end $$;

  -- FIX ROUND 2, ITEM 2: an explicit NULL category_key must still mean
  -- "this set's overall cap" -- the deliberate case, which must keep
  -- working even after blank-string input is refused (below).
  do $$
  declare v_id uuid; v_key text;
  begin
    v_id := set_budget(null, '2026-11-01', 50000,
      array['cccccccc-0000-0000-0000-0000000000b2']::uuid[]);
    select category_key into v_key from public.budgets where id = v_id;
    assert v_key is null,
      format('OVERALL CAP BROKEN: an explicit NULL category_key should stay NULL, found %L', v_key);
  end $$;

  -- FIX ROUND 2, ITEM 2 (REJECT): an empty-string category must be
  -- refused, not silently reinterpreted as the overall cap. Before this
  -- fix, `nullif(lower(btrim(p_category_key)), '')` turned '' into NULL,
  -- so a blank client form field would silently create/edit the
  -- household's overall budget instead of erroring.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('', '2026-11-01', 50000,
        array['cccccccc-0000-0000-0000-0000000000b2']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'a category budget needs a category',
        format('wrong error for empty-string category: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget silently treated an empty-string category as the overall cap';
  end $$;

  -- FIX ROUND 2, ITEM 2 (REJECT): same, for a whitespace-only string --
  -- btrim('   ') = '', which must be caught the same way as ''  itself.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('   ', '2026-11-01', 50000,
        array['cccccccc-0000-0000-0000-0000000000b2']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'a category budget needs a category',
        format('wrong error for whitespace-only category: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget silently treated a whitespace-only category as the overall cap';
  end $$;

  -- FIX ROUND 2, ITEM 4: a duplicate wallet id in the submitted array, where
  -- the caller genuinely IS a member of the repeated wallet, must be
  -- refused with an accurate message -- not "not a member of every account
  -- in that set" (false: alice IS a member of b1). This is a pre-check,
  -- asserted separately from REJECT 3/3b above (which cover a genuine
  -- non-member) so the two error messages are never confused for one
  -- another.
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('groceries', '2026-11-01', 50000,
        array['cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-0000000000b1']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'the same account is listed twice in that set',
        format('wrong error for duplicate wallet id: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget accepted (or mis-messaged) a wallet set with a duplicate id';
  end $$;

  -- ACCEPT + REJECT 4: calling set_budget twice for the SAME category, set
  -- and month must leave exactly ONE row, carrying the SECOND amount. Row
  -- count is asserted, not only the amount, since "updated" and "inserted a
  -- duplicate" read identically if only the amount is checked.
  do $$
  declare v_id1 uuid; v_id2 uuid; v_rows int; v_amount bigint;
  begin
    v_id1 := set_budget('dining', '2026-12-01', 30000,
      array['cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-0000000000b2']::uuid[]);
    v_id2 := set_budget('dining', '2026-12-01', 45000,
      array['cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-0000000000b2']::uuid[]);

    assert v_id1 = v_id2,
      format('IDEMPOTENCY BROKEN: second call for the same set/category/month returned a different id (%s vs %s)', v_id1, v_id2);

    -- REVIEW FINDING (I2): filtering this count by `and id = v_id1` (an
    -- earlier draft did) makes it structurally 0 or 1 no matter what --
    -- primary-key equality can never observe a genuine duplicate row, which
    -- is exactly the failure mode this count exists to catch. Filtering by
    -- category_key/period_start only, over the WHOLE table, is what
    -- actually distinguishes "updated in place" (1 row) from "inserted a
    -- second budget" (2 rows).
    select count(*) into v_rows from public.budgets
      where category_key = 'dining' and period_start = '2026-12-01';
    assert v_rows = 1,
      format('IDEMPOTENCY BROKEN: expected exactly 1 row for the repeated set/category/month, found %s', v_rows);

    select amount_minor into v_amount from public.budgets where id = v_id1;
    assert v_amount = 45000,
      format('IDEMPOTENCY BROKEN: row should carry the second call''s amount (45000), found %s', v_amount);
  end $$;

  -- ACCEPT 5: the same category and month over a DIFFERENT set creates a
  -- SECOND budget -- overlapping budgets are a supported feature, not a
  -- collision.
  do $$
  declare v_id1 uuid; v_id2 uuid; v_rows int;
  begin
    v_id1 := set_budget('transport', '2026-12-01', 10000,
      array['cccccccc-0000-0000-0000-0000000000b1']::uuid[]);
    v_id2 := set_budget('transport', '2026-12-01', 20000,
      array['cccccccc-0000-0000-0000-0000000000b2']::uuid[]);

    assert v_id1 <> v_id2,
      'OVERLAP BROKEN: same category/month over a DIFFERENT wallet set collapsed onto the same budget id';

    select count(*) into v_rows from public.budgets
      where category_key = 'transport' and period_start = '2026-12-01';
    assert v_rows = 2,
      format('OVERLAP BROKEN: expected 2 distinct budgets for the same category/month over different sets, found %s', v_rows);
  end $$;
commit;

-- Recurring rules and skips (0015). Fresh fixtures: a user, a wallet, and a
-- category, following this file's own convention of literal UUIDs and
-- direct insert into wallets/categories inside a do $$ ... $$ block --
-- there is no test_wallet_id()/test_category_id() helper in this file (see
-- task-2-brief.md's own caveat that those names were placeholders).
insert into auth.users (id, email) values
  ('ffffffff-0000-0000-0000-000000000001', 'frank@x.io');
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
  values ('ffffffff-0000-0000-0000-000000000002',
          'ffffffff-0000-0000-0000-000000000001', 'Frank Bank', 'bank', 'USD', 1, 'landmark');
insert into categories (id, wallet_id, name, kind, color_slot, icon)
  values ('ffffffff-0000-0000-0000-000000000003',
          'ffffffff-0000-0000-0000-000000000002', 'Recurring Test Category', 'expense', 3, 'repeat');

\echo '--- recurring_rules: sign must follow kind ---'
do $$
begin
  begin
    insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                                 category_id, interval_unit, anchor_on)
    values ('ffffffff-0000-0000-0000-000000000002', 'Bad', 'expense', 500, 'USD',
            'ffffffff-0000-0000-0000-000000000003', 'monthly', current_date);
    raise exception 'expected rule_expense_is_negative to reject a positive expense';
  exception when check_violation then
    assert sqlerrm like '%rule_expense_is_negative%',
      format('wrong constraint fired: %s', sqlerrm);
  end;
end $$;

\echo '--- recurring_rules: a transfer rule is refused outright ---'
do $$
begin
  begin
    insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                                 category_id, interval_unit, anchor_on)
    values ('ffffffff-0000-0000-0000-000000000002', 'Bad', 'transfer', -500, 'USD',
            'ffffffff-0000-0000-0000-000000000003', 'monthly', current_date);
    raise exception 'expected rule_kind_not_transfer to reject a transfer rule';
  exception when check_violation then
    assert sqlerrm like '%rule_kind_not_transfer%',
      format('wrong constraint fired: %s', sqlerrm);
  end;
end $$;

\echo '--- recurring_rules: ends_on cannot precede the anchor ---'
do $$
begin
  begin
    insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                                 category_id, interval_unit, anchor_on, ends_on)
    values ('ffffffff-0000-0000-0000-000000000002', 'Bad', 'expense', -500, 'USD',
            'ffffffff-0000-0000-0000-000000000003', 'monthly', '2026-06-01', '2026-05-01');
    raise exception 'expected rule_ends_after_anchor to reject an earlier end';
  exception when check_violation then
    assert sqlerrm like '%rule_ends_after_anchor%',
      format('wrong constraint fired: %s', sqlerrm);
  end;
end $$;

\echo '--- one occurrence cannot be recorded twice ---'
do $$
declare r uuid;
begin
  insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                               category_id, interval_unit, anchor_on)
  values ('ffffffff-0000-0000-0000-000000000002', 'Rent', 'expense', -150000, 'USD',
          'ffffffff-0000-0000-0000-000000000003', 'monthly', '2026-01-01')
  returning id into r;

  insert into transactions (wallet_id, kind, amount_minor, currency_code,
                            category_id, occurred_on, recurring_id)
  values ('ffffffff-0000-0000-0000-000000000002', 'expense', -150000, 'USD',
          'ffffffff-0000-0000-0000-000000000003', '2026-01-01', r);

  begin
    insert into transactions (wallet_id, kind, amount_minor, currency_code,
                              category_id, occurred_on, recurring_id)
    values ('ffffffff-0000-0000-0000-000000000002', 'expense', -150000, 'USD',
            'ffffffff-0000-0000-0000-000000000003', '2026-01-01', r);
    raise exception 'expected the partial unique index to refuse a second record';
  exception when unique_violation then
    assert sqlerrm like '%transactions_recurring_occurrence%',
      format('wrong index fired: %s', sqlerrm);
  end;

  -- Soft-deleting the first frees the occurrence again: the index is partial
  -- on deleted_at, which is what makes an undone Record re-recordable.
  update transactions set deleted_at = now()
   where recurring_id = r and occurred_on = '2026-01-01';
  insert into transactions (wallet_id, kind, amount_minor, currency_code,
                            category_id, occurred_on, recurring_id)
  values ('ffffffff-0000-0000-0000-000000000002', 'expense', -150000, 'USD',
          'ffffffff-0000-0000-0000-000000000003', '2026-01-01', r);
end $$;

-- Fix round 1 (task-2-fix-1) coverage. A second wallet/category, owned by
-- the same fixture user (this file bypasses RLS and tests CHECK/FK shape,
-- not membership -- see the header comment), is what makes "cross-wallet"
-- a real distinction to test against below.
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
  values ('ffffffff-0000-0000-0000-000000000004',
          'ffffffff-0000-0000-0000-000000000001', 'Frank Second Wallet', 'bank', 'USD', 2, 'wallet');
insert into categories (id, wallet_id, name, kind, color_slot, icon)
  values ('ffffffff-0000-0000-0000-000000000005',
          'ffffffff-0000-0000-0000-000000000004', 'Second Wallet Category', 'expense', 4, 'basket');

\echo '--- Fix 2: recurring_rules_category_same_wallet rejects a cross-wallet category ---'
do $$
declare v_sqlstate text; v_constraint text;
begin
  insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                               category_id, interval_unit, anchor_on)
  values ('ffffffff-0000-0000-0000-000000000002', 'Bad', 'expense', -500, 'USD',
          'ffffffff-0000-0000-0000-000000000005', 'monthly', current_date);
  raise exception 'CONSTRAINT BROKEN: recurring_rules_category_same_wallet accepted a cross-wallet category';
exception
  when foreign_key_violation then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
    assert v_sqlstate = '23503' and v_constraint = 'recurring_rules_category_same_wallet',
      format('expected foreign_key_violation (23503) from recurring_rules_category_same_wallet, got SQLSTATE %s (constraint %s): %s',
             v_sqlstate, v_constraint, sqlerrm);
end $$;

\echo '--- Fix 3: transactions_recurring_same_wallet rejects cross-wallet occurrence squatting ---'
do $$
declare r uuid; v_sqlstate text; v_constraint text;
begin
  insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                               category_id, interval_unit, anchor_on)
  values ('ffffffff-0000-0000-0000-000000000002', 'Squat Target', 'expense', -2000, 'USD',
          'ffffffff-0000-0000-0000-000000000003', 'monthly', '2026-02-01')
  returning id into r;

  begin
    -- A transaction in the OTHER wallet, carrying this rule's id -- the
    -- squatting shape the reviewer proved live: nothing but this composite
    -- FK ties recurring_id to the SAME wallet as the rule it names.
    insert into transactions (wallet_id, kind, amount_minor, currency_code,
                              category_id, occurred_on, recurring_id)
    values ('ffffffff-0000-0000-0000-000000000004', 'expense', -2000, 'USD',
            'ffffffff-0000-0000-0000-000000000005', '2026-02-01', r);
    raise exception 'CONSTRAINT BROKEN: transactions_recurring_same_wallet accepted a cross-wallet recurring_id';
  exception
    when foreign_key_violation then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      assert v_sqlstate = '23503' and v_constraint = 'transactions_recurring_same_wallet',
        format('expected foreign_key_violation (23503) from transactions_recurring_same_wallet, got SQLSTATE %s (constraint %s): %s',
               v_sqlstate, v_constraint, sqlerrm);
  end;
end $$;

\echo '--- Fix 5: on delete set null -- deleting a rule must not delete recorded money ---'
do $$
declare r uuid; v_txn_id uuid; v_recurring_id uuid; v_wallet_id uuid; v_deleted_at timestamptz;
begin
  insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                               category_id, interval_unit, anchor_on)
  values ('ffffffff-0000-0000-0000-000000000002', 'Doomed Rule', 'expense', -3000, 'USD',
          'ffffffff-0000-0000-0000-000000000003', 'monthly', '2026-03-01')
  returning id into r;

  insert into transactions (wallet_id, kind, amount_minor, currency_code,
                            category_id, occurred_on, recurring_id)
  values ('ffffffff-0000-0000-0000-000000000002', 'expense', -3000, 'USD',
          'ffffffff-0000-0000-0000-000000000003', '2026-03-01', r)
  returning id into v_txn_id;

  delete from recurring_rules where id = r;

  select recurring_id, wallet_id, deleted_at into v_recurring_id, v_wallet_id, v_deleted_at
    from transactions where id = v_txn_id;
  assert found, 'SAFETY BROKEN: transactions.recurring_id ON DELETE SET NULL let the whole row disappear (found no row at all -- check for an accidental CASCADE)';
  assert v_deleted_at is null,
    'SAFETY BROKEN: deleting a recurring rule soft-deleted (or otherwise touched deleted_at on) a real recorded transaction';
  assert v_recurring_id is null,
    'SAFETY BROKEN: transactions.recurring_id was not nulled after its rule was deleted -- ON DELETE is not SET NULL any more';
  assert v_wallet_id = 'ffffffff-0000-0000-0000-000000000002',
    'SAFETY BROKEN: wallet_id was disturbed by the rule deletion (composite-FK SET NULL must only touch recurring_id)';
end $$;

\echo '--- Fix 5: rule_income_is_positive rejects a non-positive income rule ---'
do $$
declare v_sqlstate text; v_constraint text;
begin
  insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                               category_id, interval_unit, anchor_on)
  values ('ffffffff-0000-0000-0000-000000000002', 'Bad Income', 'income', -500, 'USD',
          'ffffffff-0000-0000-0000-000000000003', 'monthly', current_date);
  raise exception 'CONSTRAINT BROKEN: rule_income_is_positive did not reject a negative income rule';
exception
  when check_violation then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
    assert v_sqlstate = '23514' and v_constraint = 'rule_income_is_positive',
      format('expected check_violation (23514) from rule_income_is_positive, got SQLSTATE %s (constraint %s): %s',
             v_sqlstate, v_constraint, sqlerrm);
end $$;

\echo '--- Fix 5: recurring_skips_pkey is the idempotency guarantee -- same (rule_id, occurrence_on) twice must raise ---'
do $$
declare r uuid; v_sqlstate text; v_constraint text;
begin
  insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                               category_id, interval_unit, anchor_on)
  values ('ffffffff-0000-0000-0000-000000000002', 'Skip Me', 'expense', -750, 'USD',
          'ffffffff-0000-0000-0000-000000000003', 'monthly', '2026-04-01')
  returning id into r;

  insert into recurring_skips (rule_id, occurrence_on) values (r, '2026-04-01');

  begin
    insert into recurring_skips (rule_id, occurrence_on) values (r, '2026-04-01');
    raise exception 'CONSTRAINT BROKEN: recurring_skips_pkey did not reject a duplicate (rule_id, occurrence_on)';
  exception
    when unique_violation then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      assert v_sqlstate = '23505' and v_constraint = 'recurring_skips_pkey',
        format('expected unique_violation (23505) from recurring_skips_pkey, got SQLSTATE %s (constraint %s): %s',
               v_sqlstate, v_constraint, sqlerrm);
  end;
end $$;

\echo '--- Fix 5: recurring_rules_name_check rejects a whitespace-only name ---'
do $$
declare v_sqlstate text; v_constraint text;
begin
  insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                               category_id, interval_unit, anchor_on)
  values ('ffffffff-0000-0000-0000-000000000002', '   ', 'expense', -500, 'USD',
          'ffffffff-0000-0000-0000-000000000003', 'monthly', current_date);
  raise exception 'CONSTRAINT BROKEN: recurring_rules_name_check accepted a whitespace-only name';
exception
  when check_violation then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
    assert v_sqlstate = '23514' and v_constraint = 'recurring_rules_name_check',
      format('expected check_violation (23514) from recurring_rules_name_check, got SQLSTATE %s (constraint %s): %s',
             v_sqlstate, v_constraint, sqlerrm);
end $$;

\echo '--- Fix round 2 (task-4-fix-2): transactions_currency_matches_wallet rejects a transaction whose currency does not match its wallet''s ---'
-- CRITICAL finding: src/server/actions/recurring.ts's own currency check is
-- a UI courtesy, not a boundary -- `authenticated` holds a full-table
-- INSERT grant on `transactions` and `transactions_member` RLS only checks
-- membership, never currency, so an ordinary member's session (not
-- service-role) can POST a wrong-currency row straight past the app
-- entirely. This constraint is the actual boundary. The REJECT below is
-- paired with a POSITIVE (a same-currency insert into the same wallet),
-- following this file's own convention: a denial only proves something
-- when paired with the corresponding permission.
do $$
declare v_sqlstate text; v_constraint text;
begin
  insert into public.transactions (wallet_id, kind, amount_minor, currency_code, category_id, occurred_on)
  values ('ffffffff-0000-0000-0000-000000000002', 'expense', -999900, 'JPY',
          'ffffffff-0000-0000-0000-000000000003', current_date);
  raise exception 'CONSTRAINT BROKEN: transactions_currency_matches_wallet accepted a transaction whose currency does not match its wallet''s';
exception
  when foreign_key_violation then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
    assert v_sqlstate = '23503' and v_constraint = 'transactions_currency_matches_wallet',
      format('expected foreign_key_violation (23503) from transactions_currency_matches_wallet, got SQLSTATE %s (constraint %s): %s',
             v_sqlstate, v_constraint, sqlerrm);
end $$;

-- POSITIVE: the wallet's OWN currency is accepted. Without this, a
-- constraint (or an insert path) that rejected EVERY currency_code would
-- sail through the REJECT above -- the denial only means something paired
-- with a permission.
do $$
declare n int;
begin
  insert into public.transactions (wallet_id, kind, amount_minor, currency_code, category_id, occurred_on)
  values ('ffffffff-0000-0000-0000-000000000002', 'expense', -100, 'USD',
          'ffffffff-0000-0000-0000-000000000003', current_date);

  select count(*) into n from public.transactions
  where wallet_id = 'ffffffff-0000-0000-0000-000000000002' and currency_code = 'USD' and amount_minor = -100;
  assert n = 1,
    format('CONSTRAINT BROKEN: transactions_currency_matches_wallet rejected the wallet''s OWN currency (%s row(s) landed)', n);
end $$;

\echo '--- Fix round 2: wallets_id_currency + transactions_currency_matches_wallet ON DELETE CASCADE agrees with transactions_wallet_id_fkey -- deleting a wallet with transactions must not error ---'
do $$
declare v_wallet uuid; v_owner uuid; v_cat uuid; n int;
begin
  insert into auth.users (id, email) values ('88888888-0000-0000-0000-000000000099','cascade-check@x.io')
    returning id into v_owner;
  insert into wallets (owner_id, name, kind, currency_code, color_slot, icon)
    values (v_owner, 'Cascade Check Wallet', 'bank', 'USD', 3, 'landmark')
    returning id into v_wallet;
  select id into v_cat from categories where wallet_id = v_wallet and kind = 'expense' limit 1;
  insert into transactions (wallet_id, kind, amount_minor, currency_code, category_id, occurred_on)
    values (v_wallet, 'expense', -500, 'USD', v_cat, current_date);

  delete from wallets where id = v_wallet;

  select count(*) into n from transactions where wallet_id = v_wallet;
  assert n = 0,
    format('SAFETY BROKEN: deleting a wallet with transactions did not cascade-delete them (%s row(s) remain) -- transactions_currency_matches_wallet''s ON DELETE CASCADE disagrees with transactions_wallet_id_fkey''s', n);
end $$;
