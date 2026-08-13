-- ACCEPT blocks below must succeed; REJECT blocks must FAIL with a distinct
-- CHECK constraint violation (transfer_shape has two independent ways to
-- fail — a missing transfer_id, and a set category_id — both exercised).
-- Run with ON_ERROR_STOP off and read the notices.
\set ON_ERROR_STOP off
begin;
  insert into auth.users (id,email) values ('22222222-2222-2222-2222-222222222222','b@x.io');
  insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
    values ('33333333-3333-3333-3333-333333333333',
            '22222222-2222-2222-2222-222222222222','Main','bank','USD',1,'landmark');
  insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
    values ('44444444-4444-4444-4444-444444444444',
            '22222222-2222-2222-2222-222222222222','Secondary','card','USD',2,'wallet');
  insert into categories (id,owner_id,name,kind,color_slot,icon)
    values ('55555555-5555-5555-5555-555555555555',
            '22222222-2222-2222-2222-222222222222','Groceries','expense',1,'shopping-cart');

  -- ACCEPT: a valid expense row must succeed
  savepoint good_expense;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'expense', -500, 'USD', current_date);
  release savepoint good_expense;

  -- ACCEPT: a valid income row must succeed
  savepoint good_income;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'income', 500, 'USD', current_date);
  release savepoint good_income;

  -- ACCEPT: a valid transfer pair (opposite signs, distinct wallets, shared transfer_id) must succeed
  savepoint good_transfer_pair;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,transfer_id,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'transfer', -500, 'USD', '66666666-6666-6666-6666-666666666666', current_date);
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,transfer_id,occurred_on)
    values ('44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222',
            'transfer', 500, 'USD', '66666666-6666-6666-6666-666666666666', current_date);
  release savepoint good_transfer_pair;

  -- REJECT: expense with a positive amount -> expense_is_negative
  savepoint bad_expense_is_negative;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'expense', 500, 'USD', current_date);
  rollback to savepoint bad_expense_is_negative;

  -- REJECT: income with a negative amount -> income_is_positive
  savepoint bad_income_is_positive;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'income', -500, 'USD', current_date);
  rollback to savepoint bad_income_is_positive;

  -- REJECT: transfer without transfer_id -> transfer_shape
  savepoint bad_transfer_shape_missing_transfer_id;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'transfer', -500, 'USD', current_date);
  rollback to savepoint bad_transfer_shape_missing_transfer_id;

  -- REJECT: transfer WITH a category_id -> transfer_shape
  savepoint bad_transfer_shape_has_category;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,category_id,transfer_id,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'transfer', -500, 'USD', '55555555-5555-5555-5555-555555555555', gen_random_uuid(), current_date);
  rollback to savepoint bad_transfer_shape_has_category;

  -- REJECT: expense WITH a transfer_id -> non_transfer_no_link
  savepoint bad_non_transfer_no_link;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,transfer_id,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'expense', -500, 'USD', gen_random_uuid(), current_date);
  rollback to savepoint bad_non_transfer_no_link;
rollback;
