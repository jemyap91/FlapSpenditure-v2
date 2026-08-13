-- Each block must FAIL. Run with ON_ERROR_STOP off and read the notices.
\set ON_ERROR_STOP off
begin;
  insert into auth.users (id,email) values ('22222222-2222-2222-2222-222222222222','b@x.io');
  insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
    values ('33333333-3333-3333-3333-333333333333',
            '22222222-2222-2222-2222-222222222222','Main','bank','USD',1,'landmark');

  -- expense with a positive amount -> expense_is_negative
  savepoint bad_expense_is_negative;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'expense', 500, 'USD', current_date);
  rollback to savepoint bad_expense_is_negative;

  -- income with a negative amount -> income_is_positive
  savepoint bad_income_is_positive;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'income', -500, 'USD', current_date);
  rollback to savepoint bad_income_is_positive;

  -- transfer without transfer_id -> transfer_shape
  savepoint bad_transfer_shape;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'transfer', -500, 'USD', current_date);
  rollback to savepoint bad_transfer_shape;

  -- expense WITH a transfer_id -> non_transfer_no_link
  savepoint bad_non_transfer_no_link;
  insert into transactions (wallet_id,created_by,kind,amount_minor,currency_code,transfer_id,occurred_on)
    values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
            'expense', -500, 'USD', gen_random_uuid(), current_date);
  rollback to savepoint bad_non_transfer_no_link;
rollback;
