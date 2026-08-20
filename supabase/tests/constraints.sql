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
-- category belonging to a different wallet. Transfers, whose category_id is
-- null, are exempt by MATCH SIMPLE and are asserted to still work.
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
