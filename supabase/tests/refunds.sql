-- supabase/tests/refunds.sql
-- Assertions for 0029-0031 (refunds). ACCEPT blocks are plain statements;
-- REJECT blocks catch the expected failure and assert SQLSTATE plus the
-- constraint name or trigger message, the same discipline as constraints.sql.
\set ON_ERROR_STOP on

-- Fixture: user A with three wallets (card USD, bank USD, euro EUR) in one
-- household; user B in a DIFFERENT household with a USD expense; user C who
-- is a member of A's bank wallet only.
insert into auth.users (id, email) values
  ('f0000000-0000-4000-8000-00000000000a', 'refund-a@x.io'),
  ('f0000000-0000-4000-8000-00000000000b', 'refund-b@x.io'),
  ('f0000000-0000-4000-8000-00000000000c', 'refund-c@x.io');

insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-00000000000a', 'Card', 'card', 'USD', 1, 'credit-card'),
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-00000000000a', 'Bank', 'bank', 'USD', 2, 'landmark'),
  ('f1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-00000000000a', 'Euro', 'bank', 'EUR', 3, 'landmark'),
  ('f1000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-00000000000b', 'B Main', 'bank', 'USD', 1, 'landmark');

insert into wallet_members (wallet_id, user_id, role)
  values ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-00000000000c', 'member');

insert into categories (id, space_id, name, kind, color_slot, icon) values
  ('f2000000-0000-4000-8000-000000000001',
   (select space_id from wallets where id = 'f1000000-0000-4000-8000-000000000001'),
   'Refund Test Eating', 'expense', 1, 'utensils'),
  ('f2000000-0000-4000-8000-000000000002',
   (select space_id from wallets where id = 'f1000000-0000-4000-8000-000000000001'),
   'Refund Test Groceries', 'expense', 2, 'shopping-basket'),
  ('f2000000-0000-4000-8000-000000000003',
   (select space_id from wallets where id = 'f1000000-0000-4000-8000-000000000004'),
   'Refund Test B', 'expense', 1, 'utensils');

-- Expense E1: -25.00 on the card, 2026-09-30, Eating.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on) values
  ('f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-00000000000a', 'expense', -2500, 'USD',
   'f2000000-0000-4000-8000-000000000001', '2026-09-30');
-- Income I1 on the bank.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, occurred_on) values
  ('f3000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002',
   'f0000000-0000-4000-8000-00000000000a', 'income', 10000, 'USD', '2026-09-30');
-- B's expense EB in the other household.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on) values
  ('f3000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000004',
   'f0000000-0000-4000-8000-00000000000b', 'expense', -1000, 'USD',
   'f2000000-0000-4000-8000-000000000003', '2026-09-30');

-- ACCEPT: four 5.00 repayments of E1 into the bank on 2026-10-02.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on)
select ('f4000000-0000-4000-8000-00000000000' || n)::uuid, 'f1000000-0000-4000-8000-000000000002',
       'f0000000-0000-4000-8000-00000000000a', 'refund', 500, 'USD',
       'f3000000-0000-4000-8000-000000000001', '2026-10-02'
  from generate_series(1, 4) n;

do $$ begin
  assert (select count(*) from transactions where kind = 'refund') = 4, 'ACCEPT: four refunds did not land';
  assert (select space_id from transactions where id = 'f4000000-0000-4000-8000-000000000001')
       = (select space_id from wallets where id = 'f1000000-0000-4000-8000-000000000002'),
    'ACCEPT: refund space_id not derived from its wallet';
end $$;

-- A helper for REJECT blocks: runs `stmt`, requires it to fail with `state`,
-- and requires either the constraint name or the message to equal `expect`.
create or replace function pg_temp.expect_reject(stmt text, state text, expect text) returns void
  language plpgsql as $$
declare v_state text; v_constraint text; v_msg text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_msg = message_text;
    if v_state = state and (v_constraint = expect or v_msg = expect) then
      return;
    end if;
    raise exception 'expected % / %, got % / constraint % / %', state, expect, v_state, v_constraint, v_msg;
  end;
  raise exception 'REJECT did not reject: %', stmt;
end $$;

-- refund_shape: negative amount, category set, missing link, transfer_id set.
select pg_temp.expect_reject($s$
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on)
  values ('f1000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-00000000000a','refund',-500,'USD',
          'f3000000-0000-4000-8000-000000000001','2026-10-02')$s$, '23514', 'refund_shape');
select pg_temp.expect_reject($s$
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, category_id, occurred_on)
  values ('f1000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-00000000000a','refund',500,'USD',
          'f3000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','2026-10-02')$s$,
  '23514', 'refund_shape');
select pg_temp.expect_reject($s$
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
  values ('f1000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-00000000000a','refund',500,'USD','2026-10-02')$s$,
  '23514', 'refund_shape');
-- transfer_id also trips 0003's non_transfer_no_link, which Postgres checks
-- first (constraints are evaluated alphabetically); refund_shape's own
-- transfer_id clause is redundant with it but kept as belt and braces.
select pg_temp.expect_reject($s$
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, transfer_id, occurred_on)
  values ('f1000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-00000000000a','refund',500,'USD',
          'f3000000-0000-4000-8000-000000000001', gen_random_uuid(), '2026-10-02')$s$, '23514', 'non_transfer_no_link');

-- non_refund_no_link: an expense carrying refund_of.
select pg_temp.expect_reject($s$
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, category_id, occurred_on)
  values ('f1000000-0000-4000-8000-000000000001','f0000000-0000-4000-8000-00000000000a','expense',-500,'USD',
          'f3000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','2026-10-02')$s$,
  '23514', 'non_refund_no_link');

-- Trigger: parent must be an expense.
select pg_temp.expect_reject($s$
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on)
  values ('f1000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-00000000000a','refund',500,'USD',
          'f3000000-0000-4000-8000-000000000002','2026-10-02')$s$, 'P0001', 'a repayment must repay an expense');

-- Trigger: currency must match (EUR wallet, EUR row, USD expense).
select pg_temp.expect_reject($s$
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on)
  values ('f1000000-0000-4000-8000-000000000003','f0000000-0000-4000-8000-00000000000a','refund',500,'EUR',
          'f3000000-0000-4000-8000-000000000001','2026-10-02')$s$, 'P0001', 'a repayment must be in the expense''s currency');

-- Composite FK: a refund in A's household pointing at B's expense.
select pg_temp.expect_reject($s$
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on)
  values ('f1000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-00000000000a','refund',500,'USD',
          'f3000000-0000-4000-8000-000000000003','2026-10-02')$s$, '23503', 'transactions_refund_same_space');

-- Guard: an expense with live refunds cannot be deleted, change kind, or change currency.
select pg_temp.expect_reject($s$
  update transactions set deleted_at = now() where id = 'f3000000-0000-4000-8000-000000000001'$s$,
  'P0001', 'this expense has repayments');
select pg_temp.expect_reject($s$
  update transactions set kind = 'income', amount_minor = 2500, category_id = null
   where id = 'f3000000-0000-4000-8000-000000000001'$s$, 'P0001', 'this expense has repayments');
select pg_temp.expect_reject($s$
  update transactions set currency_code = 'EUR' where id = 'f3000000-0000-4000-8000-000000000001'$s$,
  'P0001', 'this expense has repayments');

-- A refund's kind cannot be changed while it carries refund_of.
select pg_temp.expect_reject($s$
  update transactions set kind = 'income' where id = 'f4000000-0000-4000-8000-000000000001'$s$,
  '23514', 'non_refund_no_link');

-- Recurring rules cannot be refunds.
select pg_temp.expect_reject($s$
  insert into recurring_rules (wallet_id, space_id, created_by, name, kind, amount_minor, currency_code, category_id, interval_unit, anchor_on)
  values ('f1000000-0000-4000-8000-000000000002',
          (select space_id from wallets where id = 'f1000000-0000-4000-8000-000000000002'),
          'f0000000-0000-4000-8000-00000000000a', 'x', 'refund', 500, 'USD',
          'f2000000-0000-4000-8000-000000000001', 'monthly', '2026-10-01')$s$, '23514', 'rule_kind_not_refund');

-- Restore order: delete a refund, delete the expense (only possible once all
-- its refunds are gone), then restoring the refund must fail.
-- Uses a throwaway expense E2 so E1's fixture stays intact for Task 2.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on) values
  ('f3000000-0000-4000-8000-000000000009', 'f1000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-00000000000a', 'expense', -800, 'USD',
   'f2000000-0000-4000-8000-000000000001', '2026-09-10');
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on) values
  ('f4000000-0000-4000-8000-000000000009', 'f1000000-0000-4000-8000-000000000002',
   'f0000000-0000-4000-8000-00000000000a', 'refund', 300, 'USD', 'f3000000-0000-4000-8000-000000000009', '2026-09-12');
update transactions set deleted_at = now() where id = 'f4000000-0000-4000-8000-000000000009';
update transactions set deleted_at = now() where id = 'f3000000-0000-4000-8000-000000000009';
select pg_temp.expect_reject($s$
  update transactions set deleted_at = null where id = 'f4000000-0000-4000-8000-000000000009'$s$,
  'P0001', 'the repaid expense was deleted');

-- Membership: C is a member of A's bank wallet (so of A's household) but not
-- of the card wallet holding E1. Linking to E1 must fail with the SAME
-- message a non-expense gets, so it cannot be used to probe.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000c"}';
  select pg_temp.expect_reject($s$
    insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on)
    values ('f1000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-00000000000c','refund',500,'USD',
            'f3000000-0000-4000-8000-000000000001','2026-10-02')$s$, 'P0001', 'a repayment must repay an expense');
commit;

-- PostgREST helpers. repaid_expense follows RLS: A sees E1, C does not.
do $$ begin
  assert (select effective_category_id(t) from transactions t where t.id = 'f4000000-0000-4000-8000-000000000001')
       = 'f2000000-0000-4000-8000-000000000001', 'effective_category_id: refund should resolve to its expense''s category';
  assert (select effective_category_id(t) from transactions t where t.id = 'f3000000-0000-4000-8000-000000000001')
       = 'f2000000-0000-4000-8000-000000000001', 'effective_category_id: expense should keep its own category';
end $$;
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000c"}';
  do $$ begin
    assert (select count(*) from transactions t, repaid_expense(t) p
             where t.id = 'f4000000-0000-4000-8000-000000000001') = 0,
      'repaid_expense leaked an expense from a wallet the caller is not a member of';
  end $$;
commit;

-- leave_space moves an expense and its repayment together. 0025's
-- leave_space_impl defers every deferrable key and moves categorised rows
-- (the expense) before uncategorised ones (the refund), so the refund FK
-- must be deferrable or the first statement fails with 23503. Fixture as in
-- leave_space.sql: owner O shares a wallet, mate M joins and owns two
-- wallets (expense in one, its refund in the other), then M leaves.
insert into auth.users (id, email) values
  ('f5000000-0000-4000-8000-000000000001', 'refund-lo@x.io'),
  ('f5000000-0000-4000-8000-000000000002', 'refund-lm@x.io');
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('f6000000-0000-4000-8000-0000000000aa', 'f5000000-0000-4000-8000-000000000001', 'LO shared', 'bank', 'USD', 1, 'landmark');
insert into space_members (space_id, user_id, role)
values ((select space_id from wallets where id = 'f6000000-0000-4000-8000-0000000000aa'),
        'f5000000-0000-4000-8000-000000000002', 'member');
begin;
  set local request.jwt.claims = '{"sub":"f5000000-0000-4000-8000-000000000001"}';
  select set_wallet_sharing('f6000000-0000-4000-8000-0000000000aa', true, array[]::uuid[]);
commit;
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('f6000000-0000-4000-8000-0000000000b1', 'f5000000-0000-4000-8000-000000000002', 'LM1', 'card', 'USD', 2, 'credit-card'),
  ('f6000000-0000-4000-8000-0000000000b2', 'f5000000-0000-4000-8000-000000000002', 'LM2', 'bank', 'USD', 3, 'landmark');
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on) values
  ('f7000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-0000000000b1',
   'f5000000-0000-4000-8000-000000000002', 'expense', -900, 'USD',
   (select id from categories where name = 'Groceries'
      and space_id = (select space_id from wallets where id = 'f6000000-0000-4000-8000-0000000000aa')),
   '2026-09-30');
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on) values
  ('f7000000-0000-4000-8000-000000000002', 'f6000000-0000-4000-8000-0000000000b2',
   'f5000000-0000-4000-8000-000000000002', 'refund', 400, 'USD',
   'f7000000-0000-4000-8000-000000000001', '2026-10-02');
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f5000000-0000-4000-8000-000000000002","email":"refund-lm@x.io"}';
  select public.leave_space((select space_id from public.wallets where id = 'f6000000-0000-4000-8000-0000000000b1'));
commit;
do $$ begin
  assert (select space_id from transactions where id = 'f7000000-0000-4000-8000-000000000001')
       = (select space_id from transactions where id = 'f7000000-0000-4000-8000-000000000002'),
    'LEAVE: expense and refund ended up in different households';
  assert (select space_id from transactions where id = 'f7000000-0000-4000-8000-000000000001')
      <> (select space_id from wallets where id = 'f6000000-0000-4000-8000-0000000000aa'),
    'LEAVE: expense did not move out of the shared household';
  assert (select refund_of from transactions where id = 'f7000000-0000-4000-8000-000000000002')
       = 'f7000000-0000-4000-8000-000000000001', 'LEAVE: refund lost its link';
end $$;

-- (Task 2 appends the report assertions below this line.)

-- ── Reports (Task 2) ────────────────────────────────────────────────────
-- A fully repaid expense in Groceries on the card: -10.00 and +10.00 back.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on) values
  ('f3000000-0000-4000-8000-000000000005', 'f1000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-00000000000a', 'expense', -1000, 'USD',
   'f2000000-0000-4000-8000-000000000002', '2026-09-15');
insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on) values
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-00000000000a', 'refund', 1000, 'USD',
   'f3000000-0000-4000-8000-000000000005', '2026-10-05');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000a"}';
  -- A card-only budget for Eating, September.
  select set_budget('f2000000-0000-4000-8000-000000000001', '2026-09-01', 5000,
                    array['f1000000-0000-4000-8000-000000000001']::uuid[]);
  do $$
  declare n int; v bigint;
  begin
    -- Card, September: Eating nets 25.00 - 20.00 = 5.00; Groceries nets 0 and drops out.
    select count(*) into n from get_category_breakdown(
      array['f1000000-0000-4000-8000-000000000001']::uuid[], '2026-09-01', '2026-09-30');
    assert n = 1, format('breakdown: expected only Eating (Groceries fully repaid), got %s rows', n);
    select total_minor into v from get_category_breakdown(
      array['f1000000-0000-4000-8000-000000000001']::uuid[], '2026-09-01', '2026-09-30');
    assert v = 500, format('breakdown: Eating should net 500 after four repayments, got %s', v);

    -- Bank, October: the refunds are attributed to the card and September, so nothing here.
    select count(*) into n from get_category_breakdown(
      array['f1000000-0000-4000-8000-000000000002']::uuid[], '2026-10-01', '2026-10-31');
    assert n = 0, format('breakdown: refunds leaked into the bank wallet / October, got %s rows', n);

    -- Budget scoped to the card sees repayments that landed in the bank.
    select spent_minor into v from get_budget_status('2026-09-01', '2026-09-30')
     where category_id = 'f2000000-0000-4000-8000-000000000001' and budget_id is not null;
    assert v = 500, format('budget: Eating on card should have spent 500, got %s', v);

    -- Money lens unchanged: bank balance = 100.00 income + 20.00 + 10.00 refunds.
    select balance_minor into v from get_wallet_balances()
     where wallet_id = 'f1000000-0000-4000-8000-000000000002';
    assert v = 13000, format('balance: bank should be 13000, got %s', v);
  end $$;
commit;

-- Over-repaid: a budget's spent never goes below zero.
insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on) values
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-00000000000a', 'refund', 900, 'USD',
   'f3000000-0000-4000-8000-000000000001', '2026-10-06');
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000a"}';
  do $$
  declare v bigint; n int;
  begin
    select spent_minor into v from get_budget_status('2026-09-01', '2026-09-30')
     where category_id = 'f2000000-0000-4000-8000-000000000001' and budget_id is not null;
    assert v = 0, format('budget: over-repaid Eating should clamp to 0, got %s', v);
    select count(*) into n from get_category_breakdown(
      array['f1000000-0000-4000-8000-000000000001']::uuid[], '2026-09-01', '2026-09-30');
    assert n = 0, format('breakdown: over-repaid Eating should drop out, got %s rows', n);
  end $$;
commit;

-- spend_lines follows RLS for a direct reader: C sees none of A's card spend.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000c"}';
  do $$ begin
    assert (select count(*) from spend_lines where wallet_id = 'f1000000-0000-4000-8000-000000000001') = 0,
      'spend_lines leaked card rows to a non-member';
  end $$;
commit;

-- ── Household fixes (0032) ──────────────────────────────────────────────
-- A repayment can link wallets that a leave would split: owner SO shares a
-- wallet holding an expense, mate SM records a repayment of it into SM's
-- own private wallet, then SM leaves (taking only SM's wallet).
insert into auth.users (id, email) values
  ('f8000000-0000-4000-8000-000000000001', 'refund-so@x.io'),
  ('f8000000-0000-4000-8000-000000000002', 'refund-sm@x.io');
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('f9000000-0000-4000-8000-0000000000aa', 'f8000000-0000-4000-8000-000000000001', 'SO shared', 'bank', 'USD', 1, 'landmark');
insert into space_members (space_id, user_id, role)
values ((select space_id from wallets where id = 'f9000000-0000-4000-8000-0000000000aa'),
        'f8000000-0000-4000-8000-000000000002', 'member');
begin;
  set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000001"}';
  select set_wallet_sharing('f9000000-0000-4000-8000-0000000000aa', true, array[]::uuid[]);
commit;
insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
  ('f9000000-0000-4000-8000-0000000000b1', 'f8000000-0000-4000-8000-000000000002', 'SM private', 'card', 'USD', 2, 'credit-card');
-- Expense SX in the shared wallet; live repayment SRL and soft-deleted
-- repayment SRD, both in SM's private wallet.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on) values
  ('fa000000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-0000000000aa',
   'f8000000-0000-4000-8000-000000000001', 'expense', -1200, 'USD',
   (select id from categories where name = 'Groceries'
      and space_id = (select space_id from wallets where id = 'f9000000-0000-4000-8000-0000000000aa')),
   '2026-09-30');
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on) values
  ('fa000000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-0000000000b1',
   'f8000000-0000-4000-8000-000000000002', 'refund', 300, 'USD', 'fa000000-0000-4000-8000-000000000001', '2026-10-01'),
  ('fa000000-0000-4000-8000-000000000003', 'f9000000-0000-4000-8000-0000000000b1',
   'f8000000-0000-4000-8000-000000000002', 'refund', 200, 'USD', 'fa000000-0000-4000-8000-000000000001', '2026-10-01');
update transactions set deleted_at = now() where id = 'fa000000-0000-4000-8000-000000000003';

-- count_hidden_repayments: SO (member of the expense's wallet, not of SM's
-- private one) is told about the one live repayment; the soft-deleted one
-- does not count. A (not a member of the expense's wallet) learns nothing.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000001"}';
  do $$ begin
    assert public.count_hidden_repayments('fa000000-0000-4000-8000-000000000001') = 1,
      'HIDDEN: expense wallet member should be told of 1 repayment they cannot see';
  end $$;
commit;
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000a"}';
  do $$ begin
    assert public.count_hidden_repayments('fa000000-0000-4000-8000-000000000001') = 0,
      'HIDDEN: a non-member of the expense wallet must get 0';
  end $$;
commit;

-- (ii) A LIVE repayment crossing the split refuses the leave, and nothing moves.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","email":"refund-sm@x.io"}';
  select pg_temp.expect_reject($s$
    select public.leave_space((select space_id from public.wallets where id = 'f9000000-0000-4000-8000-0000000000aa'))$s$,
    'P0001', 'repayments link wallets that would be split');
commit;
do $$ begin
  assert (select space_id from wallets where id = 'f9000000-0000-4000-8000-0000000000b1')
       = (select space_id from wallets where id = 'f9000000-0000-4000-8000-0000000000aa'),
    'SPLIT live: the private wallet moved although the leave was refused';
  assert (select count(*) from transactions where id in ('fa000000-0000-4000-8000-000000000002',
                                                         'fa000000-0000-4000-8000-000000000003')) = 2,
    'SPLIT live: a refused leave deleted repayments';
  assert exists (select 1 from space_members
                  where user_id = 'f8000000-0000-4000-8000-000000000002'
                    and space_id = (select space_id from wallets where id = 'f9000000-0000-4000-8000-0000000000aa')),
    'SPLIT live: SM left although the leave was refused';
end $$;

-- (i) With only soft-deleted repayments crossing, the leave succeeds and
-- those rows are hard-deleted (nothing else can ever unblock the link).
update transactions set deleted_at = now() where id = 'fa000000-0000-4000-8000-000000000002';
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","email":"refund-sm@x.io"}';
  select public.leave_space((select space_id from public.wallets where id = 'f9000000-0000-4000-8000-0000000000aa'));
commit;
do $$ begin
  assert (select space_id from wallets where id = 'f9000000-0000-4000-8000-0000000000b1')
      <> (select space_id from wallets where id = 'f9000000-0000-4000-8000-0000000000aa'),
    'SPLIT deleted: the private wallet did not move';
  assert (select count(*) from transactions where id in ('fa000000-0000-4000-8000-000000000002',
                                                         'fa000000-0000-4000-8000-000000000003')) = 0,
    'SPLIT deleted: soft-deleted crossing repayments were not removed';
  assert (select space_id from transactions where id = 'fa000000-0000-4000-8000-000000000001')
       = (select space_id from wallets where id = 'f9000000-0000-4000-8000-0000000000aa'),
    'SPLIT deleted: the expense left the household with the mate';
end $$;

-- get_entry_suggestions offers expense and income notes, never a refund's.
insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, note, occurred_on) values
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-00000000000a', 'expense', -100, 'USD',
   'f2000000-0000-4000-8000-000000000001', 'Refund Test Expense Note', current_date);
insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, refund_of, note, occurred_on) values
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-00000000000a', 'refund', 100, 'USD',
   'f3000000-0000-4000-8000-000000000001', 'Refund Test Repayment Note', current_date);
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000a"}';
  do $$ begin
    assert exists (select 1 from get_entry_suggestions() where note = 'Refund Test Expense Note'),
      'SUGGEST: an expense note should be suggested';
    assert not exists (select 1 from get_entry_suggestions() where note = 'Refund Test Repayment Note'),
      'SUGGEST: a repayment note leaked into suggestions';
  end $$;
commit;

-- spend_lines' refund branch only follows links to an expense. The guard
-- trigger makes a non-expense parent unreachable through the app, so it is
-- disabled inside a rolled-back transaction to build one.
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on) values
  ('fb000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-00000000000a', 'expense', -700, 'USD', 'f2000000-0000-4000-8000-000000000002', '2026-09-20');
insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, refund_of, occurred_on) values
  ('fb000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002',
   'f0000000-0000-4000-8000-00000000000a', 'refund', 200, 'USD', 'fb000000-0000-4000-8000-000000000001', '2026-09-21');
begin;
  alter table transactions disable trigger transactions_guard_refunded_expense;
  update transactions set kind = 'income', amount_minor = 700, category_id = null
   where id = 'fb000000-0000-4000-8000-000000000001';
  do $$ begin
    assert (select count(*) from spend_lines where transaction_id = 'fb000000-0000-4000-8000-000000000002') = 0,
      'SPEND: a refund whose parent is not an expense still counted as spend';
  end $$;
rollback;
