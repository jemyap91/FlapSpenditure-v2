-- supabase/tests/rls.sql
-- Adversarial RLS tests. Alice is a legitimate user; Bob is the attacker.
-- Every block that impersonates a user runs inside an explicit
-- begin/commit and PROVES the impersonation took effect (current_user and
-- auth.uid()) before asserting anything about access -- SET LOCAL outside
-- an explicit transaction is a silent no-op that leaves the session as the
-- migration-running superuser, which would make every "denied" assertion
-- true for the wrong reason (see task-8-brief.md and task-8-report.md).
--
-- Every denial is paired with the corresponding permission, proven either
-- earlier or later in this file, so a completely broken (non-functional)
-- grants/RLS setup cannot pass by accident: this file distinguishes
-- "nobody can reach the table" from "the boundary correctly blocks Bob".
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@x.io'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@x.io');

-- =====================================================================
-- 1. Alice (legitimate owner) creates her own data.
--    This is the POSITIVE control that everything below is paired
--    against: if grants/RLS were entirely broken, this block itself
--    would fail, so every later "Bob sees/changes nothing" assertion
--    means something.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'impersonation failed: auth.uid() did not resolve to alice';
  end $$;

  insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
    values ('cccccccc-0000-0000-0000-000000000003',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Alice Bank', 'bank', 'USD', 1, 'landmark');
  -- Named 'Custom Category', not 'Groceries': migration 0008's
  -- wallet-creation seed trigger already fired on the wallet insert above
  -- and gave cccccccc-003 16 default categories including one named
  -- 'Groceries' ('expense' kind); reusing that name here would collide
  -- with categories_unique_active_name instead of proving RLS visibility.
  insert into categories (id, wallet_id, name, kind, color_slot, icon)
    values ('dddddddd-0000-0000-0000-000000000004',
            'cccccccc-0000-0000-0000-000000000003', 'Custom Category', 'expense', 2, 'basket');
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('eeeeeeee-0000-0000-0000-000000000005',
            'cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
            'expense', -1250, 'USD', 'dddddddd-0000-0000-0000-000000000004', current_date);

  do $$ begin
    assert (select count(*) from wallets)      = 1, 'PERMISSION BROKEN: alice cannot see her own wallet';
    -- Split into two assertions, not one count(*) = 17: a single combined
    -- number fires identically whether the CAUSE is a broken RLS policy or
    -- migration 0008's wallet-seeding trigger simply not having run, which
    -- would misdirect debugging toward RLS. is_default = true isolates the
    -- 16 seeded rows (proven correct in detail by supabase/tests/seed.sql);
    -- the id lookup isolates the row alice just created above.
    assert (select count(*) from categories where wallet_id = 'cccccccc-0000-0000-0000-000000000003' and is_default) = 16,
      'PERMISSION BROKEN or SEED BROKEN: alice does not have her wallet''s 16 seeded default categories';
    assert (select count(*) from categories where id = 'dddddddd-0000-0000-0000-000000000004') = 1,
      'PERMISSION BROKEN: alice cannot see her own category';
    assert (select count(*) from transactions) = 1, 'PERMISSION BROKEN: alice cannot see her own transaction';
    -- add_owner_as_member() trigger ran under security definer.
    assert (select role from wallet_members
              where wallet_id = 'cccccccc-0000-0000-0000-000000000003'
                and user_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'owner',
      'PERMISSION BROKEN: alice is not recorded as owner-member of her own wallet';
  end $$;
commit;

-- =====================================================================
-- Task 9: create_transfer's paired-row invariant. Placed here (after
-- section 1, before any Bob section) so the extra transfer legs landing
-- in cccccccc-...-003 are accounted for by every later count assertion
-- scoped to that wallet -- see the running commentary at each such
-- assertion below.
--
-- The wallets created for the transfer tests deliberately do NOT reuse
-- 'eeeeeeee-0000-0000-0000-000000000005' (the id the plan's snippet
-- used) -- that id already names Alice's transaction row created in
-- section 1 above. Different tables, so no key collision, but reusing
-- it here would be a readability trap; '77777777-...-007' and
-- '88888888-...-008' are used instead. Only 77777777-007 is a
-- create_transfer party against cccccccc-003, so it is the only one of
-- the two whose row-count cascade is tracked through the rest of this
-- file; 88888888-008 (EUR) is used solely for the cross-currency control
-- below, paired with 77777777-007 on both legs, so it never touches
-- cccccccc-003's count.
--
-- Below, "begin ... exception when others ... assert sqlerrm = ..."
-- blocks that expect create_transfer to raise have no before/after
-- row-count assertion. That would be decorative, not load-bearing: the
-- call happens inside a plpgsql exception block, whose implicit
-- subtransaction Postgres rolls back on ANY exception, so no row from a
-- raised call could persist regardless of what the function did. The
-- sqlerrm equality is the assertion that actually distinguishes "the
-- right guard fired" from "some other error happened to also raise".
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'impersonation failed: auth.uid() did not resolve to alice';
  end $$;

  insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
    values ('77777777-0000-0000-0000-000000000007',
            'aaaaaaaa-0000-0000-0000-000000000001','Alice Card','card','USD',3,'credit-card');
  insert into wallets (id,owner_id,name,kind,currency_code,color_slot,icon)
    values ('88888888-0000-0000-0000-000000000008',
            'aaaaaaaa-0000-0000-0000-000000000001','Alice EUR','bank','EUR',4,'euro');

  do $$
  declare tid uuid; legs int; bal_from bigint; bal_to bigint;
  begin
    tid := create_transfer('cccccccc-0000-0000-0000-000000000003',
                           '77777777-0000-0000-0000-000000000007',
                           5000, 5000, current_date, 'card payment');
    select count(*) into legs from transactions where transfer_id = tid;
    assert legs = 2, 'transfer must create exactly two legs';

    select coalesce(sum(amount_minor),0) into bal_from
      from transactions where wallet_id='cccccccc-0000-0000-0000-000000000003' and deleted_at is null;
    select coalesce(sum(amount_minor),0) into bal_to
      from transactions where wallet_id='77777777-0000-0000-0000-000000000007' and deleted_at is null;
    assert bal_from = -1250 - 5000, format('from balance wrong: %s', bal_from);
    assert bal_to   =  5000,        format('to balance wrong: %s', bal_to);

    -- The schema cannot enforce transfer pairing on its own (CHECK
    -- constraints only see one row at a time) -- create_transfer is the
    -- only place that can, so prove both legs actually satisfy the
    -- transfer_shape (category_id null) and non_transfer_no_link
    -- (transfer_id set) constraints, and that the two amounts really do
    -- have opposite signs.
    assert (select count(*) from transactions where transfer_id = tid and category_id is null) = 2,
      'both legs must have category_id null (transfer_shape)';
    assert (select bool_and(kind = 'transfer') from transactions where transfer_id = tid),
      'both legs must have kind = transfer';
    assert (select amount_minor from transactions
              where transfer_id = tid and wallet_id = 'cccccccc-0000-0000-0000-000000000003') = -5000,
      'the out-leg must be negative';
    assert (select amount_minor from transactions
              where transfer_id = tid and wallet_id = '77777777-0000-0000-0000-000000000007') = 5000,
      'the in-leg must be positive';

    -- Deleting by transfer_id takes BOTH legs in one statement. This is the
    -- exact statement the TypeScript action issues (Task 16) -- proving it
    -- here means the client path is covered without a function wrapping it.
    update transactions set deleted_at = now() where transfer_id = tid and deleted_at is null;
    assert (select count(*) from transactions where transfer_id = tid and deleted_at is null) = 0,
           'soft delete must take both legs';

    update transactions set deleted_at = null where transfer_id = tid;
    assert (select count(*) from transactions where transfer_id = tid and deleted_at is null) = 2,
           'restore must bring both legs back';
  end $$;
commit;

-- Control, paired with the unbalanced-transfer attacks below: a genuine
-- CROSS-currency transfer with two genuinely different amounts must
-- still succeed. This is the critical control for the balance guard --
-- a guard written to reject everything (not just same-currency
-- mismatches) would pass every attack test below and look identical to
-- a correct fix unless this also runs and passes. Uses 77777777-007 (USD)
-- and 88888888-008 (EUR) on both legs so it never touches cccccccc-003.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  do $$
  declare tid uuid; legs int; out_amt bigint; in_amt bigint;
  begin
    tid := create_transfer('77777777-0000-0000-0000-000000000007',
                           '88888888-0000-0000-0000-000000000008',
                           10000, 9200, current_date, 'usd->eur fx');
    select count(*) into legs from transactions where transfer_id = tid;
    assert legs = 2, 'cross-currency transfer must create exactly two legs';
    select amount_minor into out_amt from transactions
      where transfer_id = tid and wallet_id = '77777777-0000-0000-0000-000000000007';
    select amount_minor into in_amt from transactions
      where transfer_id = tid and wallet_id = '88888888-0000-0000-0000-000000000008';
    assert out_amt = -10000, format('cross-currency out-leg wrong: %s', out_amt);
    assert in_amt  =  9200,  format('cross-currency in-leg wrong: %s', in_amt);
  end $$;
commit;

-- Attack (Critical finding, round 2): create_transfer must reject an
-- UNBALANCED same-currency transfer. Both cccccccc-003 and 77777777-007
-- are USD, so amount_out <> amount_in has no exchange rate to justify
-- it -- it would either destroy money (out > in) or fabricate it
-- (out < in) with no error and no record. Tested in both directions.
-- Also covers the null-argument and zero/negative-amount guards, which
-- had no coverage before this round: a null slips past
-- `amount_out <= 0 or amount_in <= 0` (NULL or false = NULL, and
-- plpgsql's `if null then` takes the ELSE branch), so without an
-- explicit null check execution would reach the insert and fail on a
-- NOT NULL column instead of this function's own message.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  do $$
  begin
    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               5000, 1, current_date, null);
      raise exception 'LEAK: create_transfer allowed an unbalanced same-currency transfer (destroys money)';
    exception
      when others then
        assert sqlerrm = 'a same-currency transfer must balance',
          format('wrong rejection reason: %s', sqlerrm);
    end;

    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               1, 5000, current_date, null);
      raise exception 'LEAK: create_transfer allowed an unbalanced same-currency transfer (fabricates money)';
    exception
      when others then
        assert sqlerrm = 'a same-currency transfer must balance',
          format('wrong rejection reason: %s', sqlerrm);
    end;

    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               null, 5000, current_date, null);
      raise exception 'LEAK: create_transfer allowed a null amount_out';
    exception
      when others then
        assert sqlerrm = 'transfer amounts and date must not be null',
          format('wrong rejection reason: %s', sqlerrm);
    end;

    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               5000, null, current_date, null);
      raise exception 'LEAK: create_transfer allowed a null amount_in';
    exception
      when others then
        assert sqlerrm = 'transfer amounts and date must not be null',
          format('wrong rejection reason: %s', sqlerrm);
    end;

    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               5000, 5000, null, null);
      raise exception 'LEAK: create_transfer allowed a null on_date';
    exception
      when others then
        assert sqlerrm = 'transfer amounts and date must not be null',
          format('wrong rejection reason: %s', sqlerrm);
    end;

    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               0, 5000, current_date, null);
      raise exception 'LEAK: create_transfer allowed a zero amount_out';
    exception
      when others then
        assert sqlerrm = 'transfer amounts must be positive',
          format('wrong rejection reason: %s', sqlerrm);
    end;

    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               -5000, 5000, current_date, null);
      raise exception 'LEAK: create_transfer allowed a negative amount_out';
    exception
      when others then
        assert sqlerrm = 'transfer amounts must be positive',
          format('wrong rejection reason: %s', sqlerrm);
    end;
  end $$;
commit;

-- Attack: create_transfer must reject a transfer to the same wallet on
-- both sides, even for a caller who is a legitimate member of it.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  do $$
  begin
    perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                             'cccccccc-0000-0000-0000-000000000003',
                             1000, 1000, current_date, null);
    raise exception 'LEAK: create_transfer allowed a same-wallet transfer';
  exception
    when others then
      assert sqlerrm = 'cannot transfer to the same wallet',
        format('wrong rejection reason: %s', sqlerrm);
  end $$;
commit;

-- Attack: create_transfer must reject a caller who is not a member of
-- either wallet. Bob has no membership anywhere in the file yet.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  do $$
  begin
    perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                             '77777777-0000-0000-0000-000000000007',
                             1000, 1000, current_date, null);
    raise exception 'LEAK: create_transfer allowed a transfer by a non-member of either wallet';
  exception
    when others then
      assert sqlerrm = 'not a member of both wallets',
        format('wrong rejection reason: %s', sqlerrm);
  end $$;
commit;

-- =====================================================================
-- 2. Select-path leak: Bob (a total stranger, not a member of anything)
--    must see none of Alice's rows across all four RLS-protected tables.
--    Paired with section 1's positive result.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid,
      'impersonation failed: auth.uid() did not resolve to bob';
  end $$;

  do $$ begin
    assert (select count(*) from wallets)        = 0, 'LEAK: bob can see alice''s wallet';
    assert (select count(*) from wallet_members) = 0, 'LEAK: bob can see alice''s wallet_members row';
    -- 0, not 16: migration 0008 moved seeding from the user trigger to a
    -- wallet trigger (seed_wallet_categories, fired AFTER INSERT ON
    -- wallets), so bob -- who has not created or been added to any wallet
    -- yet at this point in the file (his first wallet is created in
    -- section 5, below) -- has zero categories of his own. An unscoped
    -- total of 0 is therefore the right expectation, and on its own it
    -- already proves alice's wallet's 16 seeded categories are invisible
    -- to him (any of them becoming visible would push the total above 0).
    -- The wallet-scoped assertion below proves the same thing more
    -- directly, targeting alice's specific wallet rather than leaning on
    -- bob's own count happening to be zero.
    assert (select count(*) from categories)     = 0, 'LEAK: bob can see alice''s category';
    assert (select count(*) from categories where wallet_id = 'cccccccc-0000-0000-0000-000000000003') = 0,
      'LEAK: bob can see alice''s categories';
    assert (select count(*) from transactions)   = 0, 'LEAK: bob can see alice''s transaction';
  end $$;
commit;

-- =====================================================================
-- 3. Required attack #1: non-member inserting a transaction into
--    another user's wallet. `using` clauses never apply to inserts --
--    `with check` is the only guard -- so this is the highest-risk path.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  do $$
  begin
    insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
      values ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002',
              'expense', -999, 'USD', current_date);
    raise exception 'LEAK: bob inserted a transaction into alice''s wallet';
  exception
    when insufficient_privilege then
      null; -- expected: WITH CHECK on transactions_member rejects it
  end $$;
commit;

-- Verify from Alice's side that the attack left no trace (still exactly 5
-- rows: her original expense, the two legs of the cccccccc-003 <->
-- 77777777-007 transfer, and the two legs of the 77777777-007 <->
-- 88888888-008 cross-currency control transfer, all from the Task 9
-- block above -- every rejected create_transfer attempt in between left
-- no trace, per that block's own comment on why).
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select count(*) from transactions) = 5,
      'LEAK: transaction count changed after bob''s rejected insert attempt';
  end $$;
commit;

-- =====================================================================
-- 4. Required attack #2: a (non-)member inserting themselves a
--    wallet_members row for a wallet they do not own -- privilege
--    escalation. members_write's WITH CHECK requires the *inserting*
--    user to own the wallet, regardless of whose user_id is being
--    granted membership.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  do $$
  begin
    insert into wallet_members (wallet_id, user_id, role)
      values ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', 'member');
    raise exception 'LEAK: bob granted himself membership on alice''s wallet';
  exception
    when insufficient_privilege then
      null; -- expected: WITH CHECK on members_write requires owner_id = auth.uid()
  end $$;
commit;

-- =====================================================================
-- 5. Required attack #3: creating a wallet with owner_id set to another
--    user. Paired with a positive control: Bob creating his OWN wallet
--    (with his own id as owner_id) must succeed.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  do $$
  begin
    insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('99999999-0000-0000-0000-000000000009',
              'aaaaaaaa-0000-0000-0000-000000000001', 'Forged Wallet', 'bank', 'USD', 3, 'landmark');
    raise exception 'LEAK: bob created a wallet owned by alice';
  exception
    when insufficient_privilege then
      null; -- expected: WITH CHECK on wallets_write requires owner_id = auth.uid()
  end $$;

  -- Positive control, paired with the denial above: Bob CAN create his own wallet.
  insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
    values ('ffffffff-0000-0000-0000-000000000006',
            'bbbbbbbb-0000-0000-0000-000000000002', 'Bob Bank', 'bank', 'USD', 1, 'landmark');
  do $$ begin
    assert (select count(*) from wallets where id = 'ffffffff-0000-0000-0000-000000000006') = 1,
      'PERMISSION BROKEN: bob cannot create his own wallet';
    assert not exists (select 1 from wallets where id = '99999999-0000-0000-0000-000000000009'),
      'LEAK: forged wallet exists after all';
  end $$;
commit;

-- =====================================================================
-- 6. Update-path and delete-path blanket denial: Bob, still a total
--    stranger to Alice's wallet, must affect zero rows on Alice's
--    transactions no matter how broad the WHERE clause.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  do $$
  declare n int;
  begin
    update transactions set note = 'pwned' where true;
    get diagnostics n = row_count;
    assert n = 0, 'LEAK: bob updated alice''s transaction rows';

    delete from transactions where true;
    get diagnostics n = row_count;
    assert n = 0, 'LEAK: bob deleted alice''s transaction rows';
  end $$;
commit;

-- Positive control paired with section 6: Alice can update AND delete her
-- own transaction. The delete uses a throwaway row inserted and removed in
-- the same block, so it does not shift any transaction counts asserted
-- later in this file.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$
  declare n int;
  begin
    update transactions set note = 'legit edit' where id = 'eeeeeeee-0000-0000-0000-000000000005';
    get diagnostics n = row_count;
    assert n = 1, 'PERMISSION BROKEN: alice cannot update her own transaction';
  end $$;

  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
    values ('11111111-0000-0000-0000-000000000011',
            'cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
            'expense', -100, 'USD', current_date);
  do $$
  declare n int;
  begin
    delete from transactions where id = '11111111-0000-0000-0000-000000000011';
    get diagnostics n = row_count;
    assert n = 1, 'PERMISSION BROKEN: alice cannot delete her own transaction';
  end $$;
commit;

-- =====================================================================
-- 7. Regression test for a real, fixed vulnerability: pg_temp shadowing
--    of is_wallet_member's wallet_members lookup. Postgres searches
--    pg_temp for unqualified relation names BEFORE consulting
--    search_path, so `set search_path = public` (the original, broken
--    version) does not stop an authenticated caller from creating a
--    temp table named wallet_members and redirecting the predicate's
--    lookup into attacker-controlled data. The fix is
--    `set search_path = ''` with `public.wallet_members` qualified in
--    the function body (migration 0004). This test creates the shadow
--    table and proves the predicate -- and everything gated on it --
--    still says no.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  -- Shape-compatible shadow table: same name, in pg_temp (searched first
  -- for unqualified references), granting bob "membership" of alice's wallet.
  create temp table wallet_members (
    wallet_id uuid not null,
    user_id   uuid not null,
    role      text not null default 'owner'
  );
  insert into wallet_members (wallet_id, user_id, role)
    values ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', 'owner');

  do $$ begin
    -- Unqualified, deliberately: this proves the actual premise of the
    -- attack -- that an unqualified `wallet_members` reference in this
    -- session resolves to the pg_temp shadow, not to public.wallet_members
    -- (which would return 0 here, since bob has no real membership row).
    -- Asserting against pg_temp.wallet_members directly would only prove
    -- the shadow table exists, not that anything resolves to it.
    assert (select count(*) from wallet_members) = 1,
      'test setup broken: unqualified wallet_members did not resolve to the pg_temp shadow';
    -- The predicate must ignore the shadow table entirely.
    assert is_wallet_member('cccccccc-0000-0000-0000-000000000003'::uuid) = false,
      'VULNERABLE: is_wallet_member() was fooled by a pg_temp shadow table';
    assert (select count(*) from public.wallets where id = 'cccccccc-0000-0000-0000-000000000003') = 0,
      'VULNERABLE: pg_temp shadowing let bob see alice''s wallet';
    assert (select count(*) from public.transactions) = 0,
      'VULNERABLE: pg_temp shadowing let bob see alice''s transactions';
  end $$;

  drop table wallet_members; -- pg_temp.wallet_members
commit;

-- =====================================================================
-- 8. Legitimate membership: Alice (owner) adds Bob as a real member.
--    This is the POSITIVE control paired with section 4's escalation
--    denial -- members_write must actually work for the wallet's owner,
--    not just always reject everyone.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  insert into public.wallet_members (wallet_id, user_id, role)
    values ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', 'member');

  do $$ begin
    assert (select role from public.wallet_members
              where wallet_id = 'cccccccc-0000-0000-0000-000000000003'
                and user_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 'member',
      'PERMISSION BROKEN: alice (owner) cannot add a member to her own wallet';
  end $$;

  -- Positive control, paired with section 9's denied rename/owner-reassign
  -- attempts below: the real owner CAN update her own wallet.
  update wallets set name = 'Alice Bank Updated' where id = 'cccccccc-0000-0000-0000-000000000003';
  do $$ begin
    assert (select name from wallets where id = 'cccccccc-0000-0000-0000-000000000003') = 'Alice Bank Updated',
      'PERMISSION BROKEN: alice (owner) cannot rename her own wallet';
  end $$;
commit;

-- =====================================================================
-- Task 9 (cont'd): now that bob is a real member of cccccccc-003 (added
-- just above) but NOT a member of 77777777-007 (alice's personal card
-- wallet, created earlier in the transfer block), this is the point in
-- the file where "member of only one of the two wallets" can be tested
-- against real membership state rather than a contrived setup.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('cccccccc-0000-0000-0000-000000000003'::uuid) = true,
      'test setup broken: bob should be a member of cccccccc-003 by now';
    assert is_wallet_member('77777777-0000-0000-0000-000000000007'::uuid) = false,
      'test setup broken: bob should not be a member of 77777777-007';
  end $$;

  -- No before/after row-count assertion here -- see the comment on the
  -- Task 9 block above: the call happens inside an exception handler
  -- whose implicit subtransaction Postgres rolls back regardless, so it
  -- cannot leave a trace either way. The sqlerrm equality below is the
  -- assertion that actually proves the right guard fired.
  do $$
  begin
    perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                             '77777777-0000-0000-0000-000000000007',
                             1000, 1000, current_date, null);
    raise exception 'LEAK: create_transfer allowed a transfer by a member of only one wallet';
  exception
    when others then
      assert sqlerrm = 'not a member of both wallets',
        format('wrong rejection reason: %s', sqlerrm);
  end $$;
commit;

-- =====================================================================
-- 9. Post-membership asymmetry (spec 4): members can SEE the wallet and
--    its shared transaction ledger; only the OWNER can CHANGE the
--    wallet or its membership list. Also (0008): wallet membership now
--    LEGITIMATELY exposes the wallet's shared categories -- categories
--    became wallet-scoped specifically to close the split where a
--    co-member could read a shared transaction but not the category it
--    pointed at (see migration 0008's header comment). That is asserted
--    below as a PERMISSION check, not a LEAK. What must still be denied
--    is a DIFFERENT wallet's categories -- membership in cccccccc-003
--    must not leak 77777777-007's, which bob is not a member of.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  do $$ begin
    -- Positive: bob, now a real member, can see the wallet, the member
    -- list, and the shared transaction ledger.
    assert (select count(*) from wallets where id = 'cccccccc-0000-0000-0000-000000000003') = 1,
      'PERMISSION BROKEN: member bob cannot see alice''s wallet';
    assert (select count(*) from public.wallet_members where wallet_id = 'cccccccc-0000-0000-0000-000000000003') = 2,
      'PERMISSION BROKEN: member bob cannot see the wallet''s member list';
    -- 2, not 1: alice's original expense plus the Task 9 transfer's
    -- out-leg, both landed in this wallet before this section runs.
    assert (select count(*) from transactions where wallet_id = 'cccccccc-0000-0000-0000-000000000003') = 2,
      'PERMISSION BROKEN: member bob cannot see the shared transaction ledger';
    -- Positive (0008): membership in the shared wallet legitimately exposes
    -- that wallet's categories -- the 16 seeded defaults plus the "Custom
    -- Category" alice created by hand in section 1, all wallet_id =
    -- cccccccc-003. This is the behaviour 0008 shipped to produce (see its
    -- header comment), not a leak.
    assert (select count(*) from categories where wallet_id = 'cccccccc-0000-0000-0000-000000000003') = 17,
      'PERMISSION BROKEN: member bob cannot see the shared wallet''s categories';
    assert (select count(*) from categories
              where wallet_id = 'cccccccc-0000-0000-0000-000000000003'
                and id = 'dddddddd-0000-0000-0000-000000000004') = 1,
      'PERMISSION BROKEN: member bob cannot see alice''s custom category on the shared wallet';
    -- Negative: membership in cccccccc-003 does not extend to alice's OTHER
    -- wallet, 77777777-007 (established not-a-member of it in the Task 9
    -- (cont'd) block above) -- category visibility still tracks wallet
    -- membership per-wallet, not "any wallet this user happens to own".
    assert (select count(*) from categories where wallet_id = '77777777-0000-0000-0000-000000000007') = 0,
      'LEAK: bob (member of a different wallet only) can see 77777777-007''s categories';
  end $$;

  -- Negative: bob (member, not owner) cannot change the wallet.
  do $$
  declare n int;
  begin
    update wallets set name = 'pwned' where id = 'cccccccc-0000-0000-0000-000000000003';
    get diagnostics n = row_count;
    assert n = 0, 'LEAK: member bob renamed alice''s wallet';
  end $$;

  -- Negative: bob (member, not owner) cannot steal ownership of the wallet
  -- via UPDATE either -- wallets_write's USING clause (owner_id = auth.uid())
  -- filters the row out before WITH CHECK is even reached, since bob is not
  -- the current owner.
  do $$
  declare n int;
  begin
    update wallets set owner_id = 'bbbbbbbb-0000-0000-0000-000000000002'
      where id = 'cccccccc-0000-0000-0000-000000000003';
    get diagnostics n = row_count;
    assert n = 0, 'LEAK: member bob reassigned alice''s wallet to himself';
  end $$;

  -- Negative: bob (member, not owner) cannot escalate his own role, nor
  -- add further members -- members_write is owner-only regardless of
  -- whether the caller is already a legitimate member.
  do $$
  declare n int;
  begin
    update public.wallet_members set role = 'owner'
      where wallet_id = 'cccccccc-0000-0000-0000-000000000003'
        and user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
    get diagnostics n = row_count;
    assert n = 0, 'LEAK: member bob escalated his own role to owner';
  end $$;

  -- Positive: bob (legitimate member now) CAN write into the shared
  -- transaction ledger -- transactions_member is intentionally
  -- wallet-scoped and symmetric, unlike wallets/wallet_members/categories.
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
    values ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002',
            'expense', -300, 'USD', current_date);
  do $$ begin
    -- 3, not 2: alice's original expense + the Task 9 transfer's out-leg +
    -- bob's own insert just above.
    assert (select count(*) from transactions where wallet_id = 'cccccccc-0000-0000-0000-000000000003') = 3,
      'PERMISSION BROKEN: legitimate member bob cannot add a transaction to the shared wallet';
  end $$;
commit;

-- =====================================================================
-- 10. Column-privilege boundary on transactions UPDATE. This closes the
--     live vulnerability found and reported in round 1: transactions_member
--     is `for all using (is_wallet_member(wallet_id)) with check
--     (is_wallet_member(wallet_id)))`. On UPDATE, `using` evaluates against
--     the OLD row and `with check` against the NEW one -- both ask the
--     identical membership question, so a member of two different wallets
--     satisfied both while moving a row between them. RLS cannot express
--     "wallet_id must not change" -- `with check` has no access to the old
--     row to compare against -- so 0004_rls.sql now narrows the blanket
--     UPDATE grant on transactions to
--     (kind, amount_minor, currency_code, category_id, occurred_on, note,
--     deleted_at, updated_at), excluding id, wallet_id, created_by,
--     transfer_id and created_at.
--     Column privilege is checked BEFORE RLS, so a denial here surfaces as
--     SQLSTATE 42501 insufficient_privilege -- the SAME code an RLS
--     `with check` denial uses. The failure messages below say "COLUMN
--     PRIVILEGE" explicitly so a future engineer debugging a 42501 doesn't
--     mistake this for a policy denial and go looking in the wrong place.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  -- Attack (the round-1 finding): bob, a real member of alice's wallet and
  -- owner of his own separate wallet, tries to migrate alice's transaction
  -- into his own wallet by reassigning wallet_id.
  do $$
  begin
    update transactions set wallet_id = 'ffffffff-0000-0000-0000-000000000006'
      where id = 'eeeeeeee-0000-0000-0000-000000000005';
    raise exception 'LEAK: bob migrated alice''s transaction into his own wallet via wallet_id';
  exception
    when insufficient_privilege then
      null; -- expected, COLUMN PRIVILEGE: authenticated has no UPDATE grant on wallet_id
  end $$;

  -- Attack: bob tries to re-attribute alice's transaction to himself via
  -- created_by -- a separately deferred finding the same grant closes.
  do $$
  begin
    update transactions set created_by = 'bbbbbbbb-0000-0000-0000-000000000002'
      where id = 'eeeeeeee-0000-0000-0000-000000000005';
    raise exception 'LEAK: bob re-attributed alice''s transaction to himself via created_by';
  exception
    when insufficient_privilege then
      null; -- expected, COLUMN PRIVILEGE: authenticated has no UPDATE grant on created_by
  end $$;

  -- Positive control, shape-identical to both attacks above (same user,
  -- same row, same wallet membership -- only the column touched differs):
  -- bob CAN update allowed columns on the very same row. Proves the two
  -- denials above are the column grant specifically, not a broken session
  -- or a table that has become unreachable for every UPDATE.
  update transactions set note = 'legit edit by member bob', amount_minor = -1300
    where id = 'eeeeeeee-0000-0000-0000-000000000005';
  do $$ begin
    assert (select note from transactions where id = 'eeeeeeee-0000-0000-0000-000000000005')
             = 'legit edit by member bob',
      'PERMISSION BROKEN (COLUMN PRIVILEGE): member bob cannot update an allowed column (note)';
    assert (select amount_minor from transactions where id = 'eeeeeeee-0000-0000-0000-000000000005') = -1300,
      'PERMISSION BROKEN (COLUMN PRIVILEGE): member bob cannot update an allowed column (amount_minor)';
    -- And the attacks truly left no trace: wallet_id/created_by unchanged.
    assert (select wallet_id from transactions where id = 'eeeeeeee-0000-0000-0000-000000000005')
             = 'cccccccc-0000-0000-0000-000000000003'::uuid,
      'LEAK: transaction wallet_id changed despite the denied UPDATE';
    assert (select created_by from transactions where id = 'eeeeeeee-0000-0000-0000-000000000005')
             = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'LEAK: transaction created_by changed despite the denied UPDATE';
  end $$;

  -- Positive control: a soft delete writes deleted_at AND updated_at in a
  -- single statement -- this is the exact shape of Task 16's setDeletedAt
  -- (backing softDeleteTransaction/restoreTransaction, and via those, Task
  -- 20's undo): `update transactions set deleted_at = <value>, updated_at =
  -- new Date().toISOString()`. No trigger maintains updated_at -- it's
  -- app-written -- so both columns must be in the granted list, and this is
  -- the shape that would have caught updated_at's omission if it had one.
  update transactions
    set deleted_at = '2030-01-01T00:00:00+00'::timestamptz,
        updated_at = '2030-01-01T00:00:00+00'::timestamptz
    where id = 'eeeeeeee-0000-0000-0000-000000000005';
  do $$ begin
    assert (select deleted_at from transactions where id = 'eeeeeeee-0000-0000-0000-000000000005')
             = '2030-01-01T00:00:00+00'::timestamptz,
      'PERMISSION BROKEN (COLUMN PRIVILEGE): member bob cannot soft-delete (set deleted_at)';
    assert (select updated_at from transactions where id = 'eeeeeeee-0000-0000-0000-000000000005')
             = '2030-01-01T00:00:00+00'::timestamptz,
      'PERMISSION BROKEN (COLUMN PRIVILEGE): member bob cannot set updated_at alongside deleted_at';
  end $$;
commit;

-- Final sanity check as alice: her wallet still has the name and owner she
-- set in section 8 (not bob's forged rename or ownership-reassignment
-- attempts from section 9), membership was never escalated, and the wallet
-- now legitimately has two members and three transactions (her original
-- expense, the Task 9 transfer's out-leg, and bob's own insert).
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select name from wallets where id = 'cccccccc-0000-0000-0000-000000000003') = 'Alice Bank Updated',
      'LEAK: wallet name was changed by a non-owner';
    assert (select owner_id from wallets where id = 'cccccccc-0000-0000-0000-000000000003')
             = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'LEAK: wallet ownership was reassigned by a non-owner';
    assert (select role from public.wallet_members
              where wallet_id = 'cccccccc-0000-0000-0000-000000000003'
                and user_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 'member',
      'LEAK: bob''s membership role was escalated';
    assert (select count(*) from transactions where wallet_id = 'cccccccc-0000-0000-0000-000000000003') = 3,
      'unexpected transaction count on alice''s wallet';
  end $$;
commit;

-- =====================================================================
-- 11. Task 10: aggregate RPCs (get_wallet_balances, get_category_breakdown,
--     get_cash_flow). A fresh, self-contained fixture is used (new wallets
--     a2a2a2a2-...-001 / a3a3a3a3-...-001 and category a4a4a4a4-...-001)
--     rather than reusing cccccccc-003: by this point in the file, that
--     wallet's original expense (eeeeeeee-005) has had its amount edited to
--     -1300 (section 10) and then been soft-deleted (also section 10), so
--     it can no longer serve as a hand-computable breakdown fixture. The
--     new fixture includes one ordinary expense, one income, one soft-
--     deleted expense (must be ignored everywhere) and one transfer (must
--     be excluded from the category breakdown but included in cash flow,
--     per spec §3.3), so every filter each RPC relies on has something
--     concrete to prove itself against.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  insert into wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
    values ('a2a2a2a2-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Agg Wallet A', 'bank', 'USD', 10000, 5, 'landmark');
  insert into wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
    values ('a3a3a3a3-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Agg Wallet B', 'bank', 'USD', 0, 6, 'piggy-bank');
  -- wallet_id = a2a2a2a2-001, not owner_id (0008): the composite FK
  -- transactions_category_same_wallet requires a transaction's category to
  -- belong to the SAME wallet as the transaction, and this category is used
  -- below by transactions in wallet a2a2a2a2-001.
  insert into categories (id, wallet_id, name, kind, color_slot, icon)
    values ('a4a4a4a4-0000-0000-0000-000000000001',
            'a2a2a2a2-0000-0000-0000-000000000001', 'Dining', 'expense', 7, 'utensils');

  -- Wallet C: EXISTS SOLELY to prove the LEFT JOIN ... ON (t.wallet_id = w.id
  -- AND t.deleted_at is null) shape still preserves a wallet whose ONLY
  -- transaction is soft-deleted (join match fails, LEFT JOIN still emits
  -- one null-t row, outer coalesce(sum(...), 0) yields 0) -- the semantic-
  -- parity claim the 0006 migration's own comment makes about moving
  -- deleted_at from FILTER into ON.
  insert into wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
    values ('a6a6a6a6-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Agg Wallet C', 'bank', 'USD', 7500, 8, 'wallet');
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on, deleted_at)
    values ('a6a6a6a6-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
            'expense', -500, 'USD', current_date, now());

  -- Ordinary expense: -12.50, category Dining.
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('a2a2a2a2-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
            'expense', -1250, 'USD', 'a4a4a4a4-0000-0000-0000-000000000001', current_date);
  -- Income: +50.00, no category.
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
    values ('a2a2a2a2-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
            'income', 5000, 'USD', current_date);
  -- Soft-deleted expense: -99.99, category Dining -- must be excluded from
  -- get_wallet_balances, get_category_breakdown and get_cash_flow alike.
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on, deleted_at)
    values ('a5a5a5a5-0000-0000-0000-000000000001',
            'a2a2a2a2-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
            'expense', -9999, 'USD', 'a4a4a4a4-0000-0000-0000-000000000001', current_date, now());
  -- Transfer: 20.00 out of A into B -- must be excluded from the category
  -- breakdown (kind = 'expense' filter) but included in cash flow.
  do $$ begin
    perform create_transfer('a2a2a2a2-0000-0000-0000-000000000001',
                             'a3a3a3a3-0000-0000-0000-000000000001',
                             2000, 2000, current_date, 'agg test transfer');
  end $$;
commit;

-- get_wallet_balances: hand-computed expected balances.
-- Wallet A = starting 10000 + (-1250 expense) + 5000 (income) + (-2000
--   transfer-out) = 11750. The -9999 soft-deleted expense must NOT count.
-- Wallet B = starting 0 + 2000 (transfer-in) = 2000.
-- Wallet C = starting 7500 + 0 (its only transaction is soft-deleted) = 7500.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$
  declare bal_a bigint; bal_b bigint; bal_c bigint;
  begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed: auth.uid()';

    select balance_minor into bal_a from get_wallet_balances()
      where wallet_id = 'a2a2a2a2-0000-0000-0000-000000000001';
    select balance_minor into bal_b from get_wallet_balances()
      where wallet_id = 'a3a3a3a3-0000-0000-0000-000000000001';
    select balance_minor into bal_c from get_wallet_balances()
      where wallet_id = 'a6a6a6a6-0000-0000-0000-000000000001';
    assert bal_a = 11750, format('wallet A balance wrong: expected 11750, got %s', bal_a);
    assert bal_b = 2000,  format('wallet B balance wrong: expected 2000, got %s', bal_b);
    assert bal_c = 7500,
      format('wallet C balance wrong: expected 7500 (its only transaction is soft-deleted, so it must not count, but the wallet itself must still appear via the LEFT JOIN), got %s', bal_c);
  end $$;
commit;

-- get_category_breakdown: exactly 1 category (Dining), total_minor = 1250 --
-- the income, the transfer and the soft-deleted expense must not contribute.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$
  declare n int; rec record;
  begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed: auth.uid()';

    select count(*) into n from get_category_breakdown(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date);
    assert n = 1,
      format('breakdown should have exactly 1 category (income/transfer/soft-deleted excluded), got %s', n);

    select * into rec from get_category_breakdown(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date) limit 1;
    assert rec.category_id = 'a4a4a4a4-0000-0000-0000-000000000001'::uuid, 'breakdown returned the wrong category';
    assert rec.total_minor = 1250,
      format('breakdown total wrong: expected 1250 (only the -12.50 expense; the -20.00 transfer and -99.99 soft-deleted expense must not contribute), got %s', rec.total_minor);
  end $$;
commit;

-- get_cash_flow: one bucket (all activity lands on current_date), in_minor =
-- 5000 (income only), out_minor = 3250 (1250 expense + 2000 transfer-out --
-- transfers ARE included here, unlike the breakdown above). The -99.99
-- soft-deleted expense must not contribute to either side.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$
  declare n int; rec record;
  begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed: auth.uid()';

    select count(*) into n from get_cash_flow(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date, 'day');
    assert n = 1, format('cash flow should have exactly 1 bucket, got %s', n);

    select * into rec from get_cash_flow(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date, 'day') limit 1;
    assert rec.bucket_start = current_date, format('cash flow bucket_start wrong: %s', rec.bucket_start);
    assert rec.in_minor = 5000,
      format('cash flow in_minor wrong: expected 5000 (income only), got %s', rec.in_minor);
    assert rec.out_minor = 3250,
      format('cash flow out_minor wrong: expected 3250 (1250 expense + 2000 transfer-out; the -99.99 soft-deleted expense must not contribute), got %s', rec.out_minor);

    -- Same fixture, 'week' bucket: still a single group (all activity is on
    -- current_date), same totals, bucket_start independently computed via
    -- date_trunc('week', ...) rather than hand-derived.
    select count(*) into n from get_cash_flow(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date, 'week');
    assert n = 1, format('cash flow (week) should have exactly 1 bucket, got %s', n);
    select * into rec from get_cash_flow(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date, 'week') limit 1;
    assert rec.bucket_start = date_trunc('week', current_date)::date,
      format('cash flow (week) bucket_start wrong: %s', rec.bucket_start);
    assert rec.in_minor = 5000 and rec.out_minor = 3250,
      format('cash flow (week) totals wrong: in=%s out=%s', rec.in_minor, rec.out_minor);

    -- 'month' bucket: same story.
    select count(*) into n from get_cash_flow(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date, 'month');
    assert n = 1, format('cash flow (month) should have exactly 1 bucket, got %s', n);
    select * into rec from get_cash_flow(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date, 'month') limit 1;
    assert rec.bucket_start = date_trunc('month', current_date)::date,
      format('cash flow (month) bucket_start wrong: %s', rec.bucket_start);
    assert rec.in_minor = 5000 and rec.out_minor = 3250,
      format('cash flow (month) totals wrong: in=%s out=%s', rec.in_minor, rec.out_minor);

    -- Invalid bucket must raise, not silently accept or silently return empty.
    begin
      perform get_cash_flow(
        array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date, 'year');
      raise exception 'LEAK: get_cash_flow accepted an invalid bucket';
    exception
      when others then
        assert sqlerrm = 'bucket must be day, week or month',
          format('wrong rejection reason: %s', sqlerrm);
    end;
  end $$;
commit;

-- Array edge cases, both functions: empty array, NULL array, and an array
-- containing a NULL element alongside a wallet Alice genuinely owns. All
-- three must return empty rather than erroring or leaking -- reasoned
-- through in review (unnest(NULL) and unnest('{}') both yield zero rows, so
-- the membership guard's exists(...) is vacuously false and the guard does
-- NOT fire, but wallet_id = any(wallet_ids) is NULL/always-false for every
-- row either way, so the main query still returns nothing; a NULL element
-- makes is_wallet_member(NULL) evaluate to false, which DOES fire the
-- guard) -- tested here rather than left as reasoning only.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$
  declare n int;
  begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed: auth.uid()';

    select count(*) into n from get_category_breakdown(
      array[]::uuid[], current_date - 30, current_date);
    assert n = 0, format('breakdown: empty array should return empty, got %s rows', n);
    select count(*) into n from get_category_breakdown(
      null::uuid[], current_date - 30, current_date);
    assert n = 0, format('breakdown: NULL array should return empty, got %s rows', n);
    select count(*) into n from get_category_breakdown(
      array[null::uuid, 'a2a2a2a2-0000-0000-0000-000000000001'::uuid], current_date - 30, current_date);
    assert n = 0,
      format('breakdown: array with a NULL element (alongside a wallet alice genuinely owns) should return empty, got %s rows', n);

    select count(*) into n from get_cash_flow(
      array[]::uuid[], current_date - 30, current_date, 'day');
    assert n = 0, format('cash flow: empty array should return empty, got %s rows', n);
    select count(*) into n from get_cash_flow(
      null::uuid[], current_date - 30, current_date, 'day');
    assert n = 0, format('cash flow: NULL array should return empty, got %s rows', n);
    select count(*) into n from get_cash_flow(
      array[null::uuid, 'a2a2a2a2-0000-0000-0000-000000000001'::uuid], current_date - 30, current_date, 'day');
    assert n = 0,
      format('cash flow: array with a NULL element (alongside a wallet alice genuinely owns) should return empty, got %s rows', n);
  end $$;
commit;

-- get_wallet_balances' archived_at filter: an archived wallet must not
-- appear, even to its own owner. Uses wallet B (a3a3a3a3-...-001); the
-- denial block below also asserts bob (never a member) doesn't see it,
-- which holds independent of archived_at, so archiving it here does not
-- invalidate that later assertion.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;
  update wallets set archived_at = now() where id = 'a3a3a3a3-0000-0000-0000-000000000001';
  do $$ begin
    assert not exists (select 1 from get_wallet_balances() where wallet_id = 'a3a3a3a3-0000-0000-0000-000000000001'),
      'get_wallet_balances() included an archived wallet';
  end $$;
commit;

-- Bob's own data, in his own pre-existing wallet ffffffff-006 (created in
-- section 5). This must be real, non-empty data: the mixed-array test below
-- needs a case where a "silently filter to authorized wallets" (or
-- "check only one array element") implementation would visibly return
-- something, so that asserting an empty result actually proves every
-- element of wallet_ids was checked, not just that bob's own data happens
-- to be empty.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  -- wallet_id = ffffffff-006, not owner_id (0008): same composite-FK
  -- reasoning as the a4a4a4a4-001 fixture above -- this category is used
  -- by the transaction below in bob's own wallet ffffffff-006.
  insert into categories (id, wallet_id, name, kind, color_slot, icon)
    values ('a4a4a4a4-0000-0000-0000-000000000002',
            'ffffffff-0000-0000-0000-000000000006', 'Bob Category', 'expense', 1, 'shopping-cart');
  insert into transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('ffffffff-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-000000000002',
            'expense', -500, 'USD', 'a4a4a4a4-0000-0000-0000-000000000002', current_date);
commit;

-- Access control: bob (not a member of wallet A) must get nothing from it,
-- from either RPC, and get_wallet_balances() must not leak alice's wallets
-- to him either.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';

    select count(*) into n from get_category_breakdown(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date);
    assert n = 0, 'LEAK: bob got category breakdown for alice''s wallet A';

    select count(*) into n from get_cash_flow(
      array['a2a2a2a2-0000-0000-0000-000000000001']::uuid[], current_date - 30, current_date, 'day');
    assert n = 0, 'LEAK: bob got cash flow for alice''s wallet A';

    assert not exists (select 1 from get_wallet_balances() where wallet_id = 'a2a2a2a2-0000-0000-0000-000000000001'),
      'LEAK: bob''s get_wallet_balances() included alice''s wallet A';
    assert not exists (select 1 from get_wallet_balances() where wallet_id = 'a3a3a3a3-0000-0000-0000-000000000001'),
      'LEAK: bob''s get_wallet_balances() included alice''s wallet B';

    -- Positive control, paired with the two denials above: get_wallet_balances()
    -- is not simply returning nothing for everyone -- bob does get his own
    -- wallet back.
    assert exists (select 1 from get_wallet_balances() where wallet_id = 'ffffffff-0000-0000-0000-000000000006'),
      'PERMISSION BROKEN: bob does not see his own wallet in get_wallet_balances()';
  end $$;
commit;

-- Access control, mixed array: exactly the case a naive membership check
-- (e.g. checking only wallet_ids[1], or filtering to authorized elements
-- instead of denying the whole batch) would pass. Bob is a real member of
-- ffffffff-006 (with real data, inserted above) and NOT a member of
-- alice's a2a2a2a2-...-001. Tested in both array orders, since a
-- first-element-only bug would only be caught by one of them.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';

    -- Sanity/positive control: bob's own wallet alone DOES return his data.
    select count(*) into n from get_category_breakdown(
      array['ffffffff-0000-0000-0000-000000000006']::uuid[], current_date - 30, current_date);
    assert n = 1, format('sanity: bob should see his own category breakdown, got %s rows', n);

    -- Mixed array, unauthorized wallet FIRST: [alice's A, bob's own].
    select count(*) into n from get_category_breakdown(
      array['a2a2a2a2-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000006']::uuid[],
      current_date - 30, current_date);
    assert n = 0,
      format('LEAK: mixed array (unauthorized first) returned %s rows -- bob got data despite an unauthorized wallet id in the array', n);

    -- Mixed array, unauthorized wallet SECOND: [bob's own, alice's A].
    select count(*) into n from get_category_breakdown(
      array['ffffffff-0000-0000-0000-000000000006', 'a2a2a2a2-0000-0000-0000-000000000001']::uuid[],
      current_date - 30, current_date);
    assert n = 0,
      format('LEAK: mixed array (unauthorized second) returned %s rows -- a naive first-element-only membership check would have passed this', n);

    -- Same mixed-array proof for get_cash_flow.
    select count(*) into n from get_cash_flow(
      array['ffffffff-0000-0000-0000-000000000006', 'a2a2a2a2-0000-0000-0000-000000000001']::uuid[],
      current_date - 30, current_date, 'day');
    assert n = 0, format('LEAK: cash flow mixed array returned %s rows', n);
  end $$;
commit;

-- =====================================================================
-- Invitations (0009). Alice owns a wallet and invites Bob. Carol is the
-- outsider who must see and do nothing.
-- =====================================================================
insert into auth.users (id, email) values ('cccccccc-0000-0000-0000-000000000009','carol@x.io');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'impersonation failed: auth.uid() did not resolve to alice';
  end $$;
  insert into public.wallet_invites (id, wallet_id, invited_email, invited_by)
  select '77777777-0000-0000-0000-000000000007', w.id, 'bob@x.io', 'aaaaaaaa-0000-0000-0000-000000000001'
  from public.wallets w where w.owner_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1;
commit;

-- Carol cannot see an invite addressed to Bob.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid,
      'impersonation failed: auth.uid() did not resolve to carol';
  end $$;
  do $$ begin
    if (select count(*) from public.wallet_invites) <> 0 then
      raise exception 'an outsider can see an invite addressed to someone else';
    end if;
  end $$;
commit;

-- Carol cannot accept an invite addressed to Bob.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid,
      'impersonation failed: auth.uid() did not resolve to carol';
  end $$;
  do $$ begin
    begin
      perform public.accept_wallet_invite('77777777-0000-0000-0000-000000000007');
      raise exception 'accept_wallet_invite let the wrong person in';
    exception when others then
      assert sqlerrm = 'invite is addressed to someone else',
        format('wrong rejection reason: %s', sqlerrm);
    end;
  end $$;
commit;

-- Bob sees his own invite, accepts it, and gains access to Alice's ledger.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid,
      'impersonation failed: auth.uid() did not resolve to bob';
  end $$;
  do $$ begin
    if (select count(*) from public.wallet_invites) <> 1 then
      raise exception 'the invitee cannot see their own invite';
    end if;
  end $$;
  select public.accept_wallet_invite('77777777-0000-0000-0000-000000000007');
  do $$ begin
    if (select status from public.wallet_invites where id = '77777777-0000-0000-0000-000000000007') <> 'accepted' then
      raise exception 'accepting did not mark the invite accepted';
    end if;
    -- The two visibility assertions that used to sit here (`count(*) from
    -- public.transactions = 0` and the same for categories, both UNSCOPED)
    -- were removed rather than repaired. Bob is already a member of
    -- cccccccc-...-003 by this point in the file, so both counts were
    -- nonzero before he accepted anything -- they could not fail, and read
    -- as load-bearing while proving nothing.
    --
    -- The Carol block further down covers this properly: a fixture she has
    -- touched nowhere else, an explicit before-state proving she cannot see
    -- that wallet's rows, and after-state assertions scoped to that
    -- wallet_id with exact expected counts.
  end $$;
commit;

-- Carol still sees nothing after Bob has joined.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid,
      'impersonation failed: auth.uid() did not resolve to carol';
  end $$;
  do $$ begin
    if (select count(*) from public.transactions) <> 0 then
      raise exception 'a non-member can read a shared wallet''s transactions';
    end if;
  end $$;
commit;

-- =====================================================================
-- Invitations, review finding #1 (CRITICAL, fixed in 0a19c10): a caller
-- whose JWT carries `sub` but NO `email` claim must not be able to
-- accept or decline ANYONE's invite. Before the fix, caller_email was
-- NULL, `lower(btrim(inv.invited_email)) <> caller_email` evaluated to
-- NULL, and PL/pgSQL treats a NULL IF-condition as FALSE -- so the
-- exception did not raise and execution fell through into creating the
-- membership row. 0009 now has an explicit `caller_email is null` OR
-- branch in both functions; this proves it actually fails closed, not
-- just that the guarding comment exists.
-- =====================================================================
insert into auth.users (id) values ('10101010-0000-0000-0000-000000000010'); -- deliberately no email claim, ever

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'impersonation failed: auth.uid() did not resolve to alice';
  end $$;
  insert into public.wallet_invites (id, wallet_id, invited_email, invited_by)
    values ('20202020-0000-0000-0000-000000000020', 'cccccccc-0000-0000-0000-000000000003',
            'dave@x.io', 'aaaaaaaa-0000-0000-0000-000000000001');
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"10101010-0000-0000-0000-000000000010"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = '10101010-0000-0000-0000-000000000010'::uuid,
      'impersonation failed: auth.uid() did not resolve to the no-email attacker';
    -- Prove the premise: this session's JWT genuinely carries no email claim.
    assert (select auth.jwt() ->> 'email') is null,
      'test setup broken: the no-email attacker''s JWT unexpectedly has an email claim';
  end $$;

  do $$ begin
    begin
      perform public.accept_wallet_invite('20202020-0000-0000-0000-000000000020');
      raise exception 'LEAK: a caller with no email claim accepted an invite addressed to someone else';
    exception
      when others then
        assert sqlerrm = 'invite is addressed to someone else',
          format('wrong rejection reason (accept): %s', sqlerrm);
    end;
  end $$;

  do $$ begin
    begin
      perform public.decline_wallet_invite('20202020-0000-0000-0000-000000000020');
      raise exception 'LEAK: a caller with no email claim declined an invite addressed to someone else';
    exception
      when others then
        assert sqlerrm = 'invite is addressed to someone else',
          format('wrong rejection reason (decline): %s', sqlerrm);
    end;
  end $$;
commit;

-- Neither attempt left a trace: the invite is still pending, and no
-- membership row was created for the attacker.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'impersonation failed: auth.uid() did not resolve to alice';
  end $$;
  do $$ begin
    assert (select status from public.wallet_invites where id = '20202020-0000-0000-0000-000000000020') = 'pending',
      'LEAK: the no-email attacker''s accept/decline attempts changed the invite status';
    assert not exists (
      select 1 from public.wallet_members
      where wallet_id = 'cccccccc-0000-0000-0000-000000000003'
        and user_id = '10101010-0000-0000-0000-000000000010'),
      'LEAK: the no-email attacker was added as a wallet member despite the rejected accept';
  end $$;
commit;

-- =====================================================================
-- Invitations, review finding #2: 0009 deliberately grants the wallet
-- owner INSERT/SELECT/DELETE on wallet_invites but no UPDATE -- status
-- must only ever move via the two SECURITY DEFINER functions above,
-- never by a direct write, not even by the invite's own wallet's owner.
-- Paired with the positive control: the SAME owner CAN insert and
-- delete (revoke) her own wallet's invites.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  -- Positive control: the owner CAN insert an invite for her own wallet.
  insert into public.wallet_invites (id, wallet_id, invited_email, invited_by)
    values ('30303030-0000-0000-0000-000000000030', 'cccccccc-0000-0000-0000-000000000003',
            'erin@x.io', 'aaaaaaaa-0000-0000-0000-000000000001');
  do $$ begin
    assert (select count(*) from public.wallet_invites where id = '30303030-0000-0000-0000-000000000030') = 1,
      'PERMISSION BROKEN: the owner cannot insert an invite for her own wallet';
  end $$;

  -- Attack: the owner tries to UPDATE status directly, bypassing
  -- accept_wallet_invite/decline_wallet_invite entirely. No UPDATE grant
  -- exists on wallet_invites at all (see 0009's header comment), so this
  -- must fail at the privilege check, before RLS is even consulted.
  do $$ begin
    begin
      update public.wallet_invites set status = 'accepted'
        where id = '30303030-0000-0000-0000-000000000030';
      raise exception 'LEAK: the wallet owner updated wallet_invites.status directly';
    exception
      when insufficient_privilege then
        null; -- expected: no UPDATE grant on wallet_invites, for anyone
    end;
  end $$;

  do $$ begin
    assert (select status from public.wallet_invites where id = '30303030-0000-0000-0000-000000000030') = 'pending',
      'LEAK: the direct UPDATE attempt actually changed the invite status';
  end $$;

  -- Positive control, paired with the denial above: the owner CAN delete
  -- (revoke) her own wallet's invite.
  delete from public.wallet_invites where id = '30303030-0000-0000-0000-000000000030';
  do $$ begin
    assert not exists (select 1 from public.wallet_invites where id = '30303030-0000-0000-0000-000000000030'),
      'PERMISSION BROKEN: the owner cannot delete (revoke) her own wallet''s invite';
  end $$;
commit;

-- =====================================================================
-- Invitations, review finding #3: the specific bug this feature exists
-- to fix (0008's "Uncategorised" split) proven on a clean fixture. Carol
-- has touched nothing else in this file, so her before/after visibility
-- of THIS wallet's categories is not obscured by access she already
-- holds elsewhere (unlike Bob, above, who was already a member of
-- cccccccc-003 by the time he accepted his invite -- which is why his
-- block's equivalent unscoped assertions were deleted rather than kept:
-- they could not fail. This block is where the claim is actually
-- proven).
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
    values ('40404040-0000-0000-0000-000000000040',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Alice Invite Wallet', 'bank', 'USD', 2, 'landmark');
  insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
    values ('40404040-0000-0000-0000-000000000040', 'aaaaaaaa-0000-0000-0000-000000000001',
            'income', 1234, 'USD', current_date);
  insert into public.wallet_invites (id, wallet_id, invited_email, invited_by)
    values ('50505050-0000-0000-0000-000000000050', '40404040-0000-0000-0000-000000000040',
            'carol@x.io', 'aaaaaaaa-0000-0000-0000-000000000001');
commit;

-- Before accepting: carol sees none of this wallet's categories or
-- transactions.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    assert (select count(*) from public.categories where wallet_id = '40404040-0000-0000-0000-000000000040') = 0,
      'test setup broken: carol can already see the invite wallet''s categories before accepting';
    assert (select count(*) from public.transactions where wallet_id = '40404040-0000-0000-0000-000000000040') = 0,
      'test setup broken: carol can already see the invite wallet''s transactions before accepting';
  end $$;

  select public.accept_wallet_invite('50505050-0000-0000-0000-000000000050');

  do $$ begin
    -- 16, the seed_wallet_categories defaults (0008) -- no custom category
    -- was created on this wallet, so this is a clean, unambiguous count.
    assert (select count(*) from public.categories where wallet_id = '40404040-0000-0000-0000-000000000040') = 16,
      'PERMISSION BROKEN: an accepted member cannot read the wallet''s categories -- the Uncategorised bug';
    assert (select count(*) from public.transactions where wallet_id = '40404040-0000-0000-0000-000000000040') = 1,
      'PERMISSION BROKEN: an accepted member cannot read the wallet''s transactions';
  end $$;
commit;

-- =====================================================================
-- Task 8 (0010): get_wallet_members() and get_pending_invites(). Both are
-- SECURITY DEFINER, added because plain RLS-scoped selects cannot supply
-- what /wallets needs -- profiles_own (0001) hides a co-member's
-- display_name from a plain wallet_members->profiles embed, and
-- wallets_select (0004, is_wallet_member) hides an invite's own wallet's
-- name from the invitee, who by definition isn't a member yet. Reuses the
-- wallet from block 11 above ('40404040-...-040', owned by Alice, Carol
-- already a member from accepting invite '50505050-...-050').
-- =====================================================================

-- get_wallet_members(): both of this wallet's real members see BOTH
-- display names -- the whole point of the function -- but a member of a
-- DIFFERENT wallet (Bob, still only on 'cccccccc-...-003') sees no row for
-- this wallet at all, not an empty display_name.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
    assert (
      select array_agg(display_name order by display_name)
      from public.get_wallet_members() where wallet_id = '40404040-0000-0000-0000-000000000040'
    ) = array['alice','carol'],
      'PERMISSION BROKEN: the owner cannot see both members'' display names via get_wallet_members()';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    assert (
      select array_agg(display_name order by display_name)
      from public.get_wallet_members() where wallet_id = '40404040-0000-0000-0000-000000000040'
    ) = array['alice','carol'],
      'PERMISSION BROKEN: a member cannot see her co-member''s display name via get_wallet_members()';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert not exists (
      select 1 from public.get_wallet_members() where wallet_id = '40404040-0000-0000-0000-000000000040'
    ), 'LEAK: a member of a different wallet can see this wallet''s members via get_wallet_members()';
  end $$;
commit;

-- Round 2 review finding: get_wallet_members() must fail at the PRIVILEGE
-- boundary for an unauthenticated caller, not merely return zero rows
-- because auth.uid() happens to be NULL for anon. Paired with the positive
-- controls immediately above (Alice and Carol, both real members, both
-- successfully calling this same function) -- this proves the denial is
-- the grant, not a broken function.
begin;
  set local role anon;
  do $$ begin
    assert (select current_user) = 'anon', 'impersonation failed: current_user is not anon';
  end $$;
  do $$ begin
    begin
      perform public.get_wallet_members();
      raise exception 'LEAK: anon executed get_wallet_members() -- no EXECUTE revoke in effect';
    exception
      when insufficient_privilege then
        null; -- expected: 0010 revokes EXECUTE from public/anon, grants only to authenticated
    end;
  end $$;
commit;

-- get_pending_invites(): Alice invites Frank to the same wallet. Before
-- Frank accepts, he must be able to name the wallet the invite is for
-- (Task 8's UI requirement) but must NOT appear as a member yet.
insert into auth.users (id, email) values ('66666666-0000-0000-0000-000000000066', 'frank@x.io');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;
  insert into public.wallet_invites (id, wallet_id, invited_email, invited_by)
    values ('60606060-0000-0000-0000-000000000060', '40404040-0000-0000-0000-000000000040',
            'frank@x.io', 'aaaaaaaa-0000-0000-0000-000000000001');
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"66666666-0000-0000-0000-000000000066","email":"frank@x.io"}';
  do $$ begin
    assert (select auth.uid()) = '66666666-0000-0000-0000-000000000066'::uuid, 'impersonation failed';
    assert (
      select wallet_name from public.get_pending_invites()
      where id = '60606060-0000-0000-0000-000000000060'
    ) = 'Alice Invite Wallet',
      'PERMISSION BROKEN: the invitee cannot see the wallet name of their own pending invite';
    assert not exists (
      select 1 from public.get_wallet_members() where wallet_id = '40404040-0000-0000-0000-000000000040'
    ), 'LEAK: an invitee who has not accepted yet already appears as (or can see) a member';
  end $$;
commit;

-- Round 2 review finding, same shape as get_wallet_members() above:
-- get_pending_invites() must also fail at the PRIVILEGE boundary for
-- anon, not merely return zero rows because auth.jwt()->>'email' is NULL.
-- Paired with Frank's positive control immediately above.
begin;
  set local role anon;
  do $$ begin
    assert (select current_user) = 'anon', 'impersonation failed: current_user is not anon';
  end $$;
  do $$ begin
    begin
      perform public.get_pending_invites();
      raise exception 'LEAK: anon executed get_pending_invites() -- no EXECUTE revoke in effect';
    exception
      when insufficient_privilege then
        null; -- expected: 0010 revokes EXECUTE from public/anon, grants only to authenticated
    end;
  end $$;
commit;

-- Carol (a real member, but not this invite's addressee) sees no row for
-- Frank's invite via get_pending_invites().
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    assert not exists (
      select 1 from public.get_pending_invites() where id = '60606060-0000-0000-0000-000000000060'
    ), 'LEAK: a wallet member who isn''t the invitee can see someone else''s pending invite';
  end $$;
commit;

-- Regression guard: neither function widened profiles_own itself -- a
-- direct SELECT on profiles is still restricted to the caller's own row.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    assert (select array_agg(id) from public.profiles) = array['cccccccc-0000-0000-0000-000000000009'::uuid],
      'LEAK: 0010 widened direct SELECT access to profiles, not just the new RPCs';
  end $$;
commit;

-- =====================================================================
-- 0011: get_category_breakdown merges same-named categories ACROSS the
-- wallets it is called with.
--
-- 0006 grouped by c.id, which was fine while a user had exactly one
-- "Groceries". 0008 gives every wallet its own copy of the 16 seeded
-- names, and the dashboard passes every same-currency active wallet id in
-- one call -- so a two-wallet user saw "Groceries" twice, in the same
-- colour, with the total split between the rows. That is guaranteed for
-- the scenario shared wallets create: onboard into your own wallet, then
-- join somebody else's.
--
-- Gina is a fresh fixture (she appears nowhere else in this file), so the
-- two transactions below are the ONLY things that can contribute to her
-- breakdown.
-- =====================================================================
insert into auth.users (id, email) values ('77770000-0000-0000-0000-000000000077', 'gina@x.io');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"77770000-0000-0000-0000-000000000077","email":"gina@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = '77770000-0000-0000-0000-000000000077'::uuid,
      'impersonation failed: auth.uid() did not resolve to gina';
  end $$;

  insert into public.wallets (id, owner_id, name, kind, currency_code, starting_balance_minor, color_slot, icon)
  values ('88880000-0000-0000-0000-000000000088','77770000-0000-0000-0000-000000000077','Gina One','bank','USD',0,1,'landmark'),
         ('99990000-0000-0000-0000-000000000099','77770000-0000-0000-0000-000000000077','Gina Two','bank','USD',0,2,'landmark');

  -- -10.00 against wallet one's own 'Groceries', -25.00 against wallet
  -- two's own 'Groceries'. Both rows come from seed_wallet_categories
  -- (0008), which is precisely why they share a name and a color_slot.
  insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
  select '88880000-0000-0000-0000-000000000088','77770000-0000-0000-0000-000000000077','expense',-1000,'USD', c.id, current_date
  from public.categories c
  where c.wallet_id = '88880000-0000-0000-0000-000000000088'
    and c.kind = 'expense' and lower(btrim(c.name)) = 'groceries';

  insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
  select '99990000-0000-0000-0000-000000000099','77770000-0000-0000-0000-000000000077','expense',-2500,'USD', c.id, current_date
  from public.categories c
  where c.wallet_id = '99990000-0000-0000-0000-000000000099'
    and c.kind = 'expense' and lower(btrim(c.name)) = 'groceries';

  do $$
  declare
    n_distinct_cats int;
    n_rows          int;
    n_total         bigint;
    n_names         int;
  begin
    -- Setup control. Without it, "one row came back" would also be
    -- satisfied by there only ever having been one category row in the
    -- first place, and the merge assertion below would be vacuous.
    select count(distinct c.id) into n_distinct_cats
    from public.categories c
    where c.wallet_id in ('88880000-0000-0000-0000-000000000088','99990000-0000-0000-0000-000000000099')
      and c.kind = 'expense' and lower(btrim(c.name)) = 'groceries';
    assert n_distinct_cats = 2,
      format('test setup broken: expected two DISTINCT same-named category rows, one per wallet, got %s', n_distinct_cats);

    select count(*), coalesce(sum(total_minor), 0), count(distinct name)
      into n_rows, n_total, n_names
    from public.get_category_breakdown(
      array['88880000-0000-0000-0000-000000000088','99990000-0000-0000-0000-000000000099']::uuid[],
      current_date - 1, current_date + 1);

    assert n_rows = 1,
      format('BREAKDOWN BROKEN: two wallets'' same-named "Groceries" must collapse to ONE row, got %s', n_rows);
    assert n_names = 1,
      format('BREAKDOWN BROKEN: expected a single category name across the merged result, got %s distinct names', n_names);
    assert n_total = 3500,
      format('BREAKDOWN BROKEN: the merged row must carry the SUMMED total 1000 + 2500 = 3500, got %s', n_total);
  end $$;

  -- Paired control for the merge: called for ONE wallet alone, only that
  -- wallet's own spend is reported. So the collapse above is a merge
  -- across the ids passed in, not a function that has stopped
  -- distinguishing wallets at all.
  do $$
  declare n_rows int; n_total bigint;
  begin
    select count(*), coalesce(sum(total_minor), 0) into n_rows, n_total
    from public.get_category_breakdown(
      array['88880000-0000-0000-0000-000000000088']::uuid[], current_date - 1, current_date + 1);
    assert n_rows = 1 and n_total = 1000,
      format('BREAKDOWN BROKEN: a single-wallet call must report only that wallet''s spend, got %s row(s) totalling %s', n_rows, n_total);
  end $$;
commit;

-- The membership guard survives the 0011 rewrite: Carol belongs to neither
-- of Gina's wallets, and passing even one unauthorised id must return
-- EMPTY rather than filtering it out. Paired with Gina's own successful
-- calls immediately above, so this proves the guard, not a broken function.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    select count(*) into n from public.get_category_breakdown(
      array['88880000-0000-0000-0000-000000000088','99990000-0000-0000-0000-000000000099']::uuid[],
      current_date - 1, current_date + 1);
    assert n = 0,
      format('LEAK: a non-member read a merged category breakdown for wallets she does not belong to (%s row(s))', n);
  end $$;
commit;


-- =====================================================================
-- Budgets (0013): TRUNCATE must not have leaked in via default privileges.
-- I7 fix round: restores the coverage the old 0012 section had for
-- `budgets` (the first table created after 0004_rls.sql's default-privilege
-- revoke was written) and extends it to `budget_wallets`, the second table
-- 0013 adds. TRUNCATE is table-level and is not filtered by RLS at all, so
-- if the default-privilege revoke did not take, one signed-in user could
-- wipe every user's budgets. No impersonation needed: has_table_privilege
-- reads the grant catalog for that role directly, regardless of the
-- session's own current_user.
-- =====================================================================
do $$ begin
  assert not has_table_privilege('authenticated', 'public.budgets', 'TRUNCATE'),
    'authenticated must not hold TRUNCATE on budgets';
  assert not has_table_privilege('anon', 'public.budgets', 'TRUNCATE'),
    'anon must not hold TRUNCATE on budgets';
  assert not has_table_privilege('authenticated', 'public.budget_wallets', 'TRUNCATE'),
    'authenticated must not hold TRUNCATE on budget_wallets';
  assert not has_table_privilege('anon', 'public.budget_wallets', 'TRUNCATE'),
    'anon must not hold TRUNCATE on budget_wallets';
end $$;

-- =====================================================================
-- Budgets (0013): N1 fix round, whole-branch review. Same "absence of a
-- grant is not the same as a revoke" reasoning as the TRUNCATE block just
-- above, now for INSERT/UPDATE/DELETE specifically -- the exact privileges
-- a legacy auto-exposed table would carry and that this section's own
-- 0013 grants never explicitly closed off before this fix round.
-- `has_table_privilege`'s privilege argument accepts a comma-separated
-- list with OR semantics (true if ANY is held), so one assertion per
-- (role, table) covers all three privileges in a single check without
-- three near-duplicate lines. The two `budgets`/authenticated assertions
-- would already be caught functionally by the direct-INSERT exercise
-- elsewhere in this file (search "authenticated genuinely cannot INSERT
-- into budgets") -- included here anyway so this section stays a complete,
-- self-contained audit of every N1 revoke on its own, the same shape the
-- TRUNCATE block above already has.
-- =====================================================================
do $$ begin
  assert not has_table_privilege('authenticated', 'public.budget_wallets', 'INSERT, UPDATE, DELETE'),
    'authenticated must not hold INSERT/UPDATE/DELETE on budget_wallets';
  assert not has_table_privilege('anon', 'public.budget_wallets', 'INSERT, UPDATE, DELETE'),
    'anon must not hold INSERT/UPDATE/DELETE on budget_wallets';
  assert not has_table_privilege('authenticated', 'public.budgets', 'INSERT'),
    'authenticated must not hold INSERT on budgets';
  assert not has_table_privilege('anon', 'public.budgets', 'INSERT'),
    'anon must not hold INSERT on budgets';
end $$;

-- =====================================================================
-- Budgets (0013): C1 fix round. This is the test that would have caught
-- the review finding: budgets_visible's original inline-subquery form read
-- budget_wallets directly, but budget_wallets carries its own RLS
-- (budget_wallets_member), and Postgres applies a REFERENCED table's RLS
-- when evaluating a query inside another table's policy expression -- the
-- same mechanism 0004_rls.sql documents from the other side for
-- is_wallet_member. The inner scan only ever saw rows the caller already
-- had access to, so `not is_wallet_member(...)` was false for every row it
-- could see, the subquery always returned zero rows, and `not exists` was
-- always TRUE: budgets_visible degenerated to `true` for everyone. The fix
-- hoists the predicate behind budget_visible(), a SECURITY DEFINER
-- function that bypasses budget_wallets' RLS the same way is_wallet_member
-- bypasses wallet_members'.
--
-- Alice's budget over her own wallet (cccccccc-003, from section 1) --
-- fixed ids (not `limit 1`-derived), for the same reason the deleted 0012
-- section gave: several actors below must target the SAME row.
--
-- C1 fix round (Task 2, later than the paragraph above): budgets INSERT is
-- now REVOKED from authenticated entirely -- an authenticated caller could
-- otherwise INSERT a budget with zero budget_wallets rows and land exactly
-- the world-readable, world-deletable row 0013's HAZARD comment (above
-- budget_visible's definition) describes, at will, with no attacker
-- required. set_budget (Task 3, SECURITY DEFINER) becomes the sole
-- creator. So this fixture's insert, like the budget_wallets attach right
-- after it, moves to superuser scope, outside any impersonation: it is
-- setup for the visibility assertions that follow, not itself a
-- permission being exercised.
-- =====================================================================
insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('b0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-08-01', 100000);

-- Attaching a wallet to the budget is done here as the table-owning
-- superuser, deliberately outside any role impersonation: I2 (below)
-- revokes INSERT/DELETE on budget_wallets from authenticated entirely --
-- composing a budget's wallet set is meant to go through set_budget
-- (Task 3), which does not exist yet. This fixture step stands in for that
-- future function call; it is setup, not the thing under test -- the
-- assertions immediately below are what actually exercises RLS.
insert into public.budget_wallets (budget_id, wallet_id)
values ('b0000000-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003');

-- Denial + positive: authenticated genuinely cannot INSERT into budgets --
-- checked at the PRIVILEGE boundary (grant revoked), not merely by RLS, so
-- this must raise insufficient_privilege even for a row alice could
-- otherwise legally own (her own id as created_by, no budget_wallets row
-- naming it, so budget_visible's WITH CHECK would pass if the grant let
-- the statement reach it). The positive control (SELECT, in the same
-- block) proves the table did not become wholesale unreachable -- only
-- INSERT is gone.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'role switch did not take effect';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'wrong impersonated user';

    begin
      insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
      values ('b0000000-0000-0000-0000-000000000099', 'aaaaaaaa-0000-0000-0000-000000000001',
              'USD', null, '2026-08-01', 1);
      raise exception 'LEAK: authenticated could INSERT into budgets directly';
    exception when insufficient_privilege then null;
    end;

    assert (select count(*) from public.budgets where id = 'b0000000-0000-0000-0000-000000000099') = 0,
      'PERMISSION BROKEN: the denied INSERT above left a row behind';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'wrong impersonated user';
    -- Positive control, paired with Carol's LEAK check immediately below: a
    -- genuine member of every wallet in the set sees the budget. Without
    -- this, a wholly broken grants/RLS setup (nobody can see anything)
    -- would make the LEAK check pass for the wrong reason.
    assert (select count(*) from public.budgets where id = 'b0000000-0000-0000-0000-000000000001') = 1,
      'PERMISSION BROKEN: a member cannot read her own budget';
  end $$;
commit;

-- Carol (a total stranger to cccccccc-003, per the grep-confirmed absence of
-- any membership grant to her anywhere in this file) must see nothing of
-- Alice's budget. THIS is the assertion that failed under the broken
-- inline-subquery policy -- see this task's report for the watch-it-fail
-- transcript proving it.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    assert (select count(*) from public.budgets where id = 'b0000000-0000-0000-0000-000000000001') = 0,
      'LEAK: a non-member can read a budget whose only wallet she does not belong to';
  end $$;
commit;

-- =====================================================================
-- Budgets (0013): I2 fix round. budget_wallets grants INSERT/DELETE to
-- nobody: foreign key checks bypass RLS entirely, so a row inserted
-- straight into budget_wallets could legally reference a budget the
-- inserting user cannot fully see or control the wallet SET of, even
-- though budget_wallets_member's own RLS predicate (is_wallet_member on
-- the NEW row's wallet alone) would happily allow it. Alice is a genuine
-- member of cccccccc-003 -- exactly the wallet named in both attempts
-- below -- so if this were an RLS gap rather than a privilege one, both
-- would silently succeed. Positive control (SELECT) proves reads still
-- work, so a wholesale-revoked table (which would also block SELECT)
-- cannot make the two denials below pass for the wrong reason.
-- =====================================================================
-- A second, wallet-less budget of Alice's own, seeded here at superuser
-- scope: budgets INSERT is no longer granted to authenticated at all (C1
-- fix round, Task 2 -- see the comment above the C1 fixture's insert,
-- earlier in this section), so there is no impersonated path left that
-- could create it. Left deliberately without a budget_wallets row: this is
-- the fixture the empty-set assertions in the get_budget_status test
-- section below (and its table-layer denial) target -- found, per that
-- task's addendum, rather than creating a second wallet-less budget.
insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('b0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-09-01', 50000);

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    -- Positive control: SELECT is still granted and RLS lets a member read
    -- the join row for a budget/wallet pair she belongs to.
    assert (select count(*) from public.budget_wallets where budget_id = 'b0000000-0000-0000-0000-000000000001') = 1,
      'PERMISSION BROKEN: a member cannot read budget_wallets for her own budget';

    -- I2: INSERT must be blocked at the PRIVILEGE boundary (grant revoked),
    -- not merely by RLS -- a member of the wallet named in the new row
    -- would satisfy budget_wallets_member's predicate, so only the missing
    -- grant stops her composing her own budget's wallet set outside
    -- set_budget (and, by the same mechanism, another user's).
    begin
      insert into public.budget_wallets (budget_id, wallet_id)
      values ('b0000000-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000003');
      raise exception 'LEAK: a member could INSERT into budget_wallets directly';
    exception when insufficient_privilege then null;
    end;

    -- I2: DELETE likewise, against the row seeded above and already proved
    -- readable.
    begin
      delete from public.budget_wallets where budget_id = 'b0000000-0000-0000-0000-000000000001';
      raise exception 'LEAK: a member could DELETE from budget_wallets directly';
    exception when insufficient_privilege then null;
    end;

    -- Confirms the denied DELETE truly did nothing (a caught exception
    -- from PL/pgSQL rolls back to an implicit savepoint, but this is the
    -- assertion that PROVES it, rather than assuming it).
    assert (select count(*) from public.budget_wallets where budget_id = 'b0000000-0000-0000-0000-000000000001') = 1,
      'PERMISSION BROKEN: budget_wallets row disappeared despite DELETE being denied';
  end $$;
commit;

-- =====================================================================
-- Budgets (0013): the actual multi-wallet semantics (re-review, item 1),
-- corrected (re-review round 2) to separate CREATOR from MEMBER. The first
-- draft of this block had budgets.created_by = alice, who was also the
-- dual-wallet member -- so a wrong `created_by = auth.uid()` policy would
-- have passed every assertion in it too (alice sees it because she made
-- it; bob doesn't because he didn't), and the inline comment claiming this
-- block "discriminates" the two was false. Fixed by making BOB the
-- creator while ALICE remains the dual-wallet member: created_by is
-- provenance only in this schema (0013's own comment: "who can see this
-- budget is decided entirely by its wallet set ... never by created_by"),
-- so this inversion is exactly what should make a `created_by`-based
-- policy fail and the real one pass. This single block now closes both
-- axes: EVERY-vs-ANY wallet membership, and membership-vs-creation.
--
-- Alice creates a SECOND wallet, deliberately a FRESH one rather than
-- reusing an earlier wallet from this 1900+ line file: bob's membership
-- elsewhere by this point depends on the Invitations section's
-- `... where w.owner_id = 'aaaaaaaa...' limit 1` (unordered), which could
-- have landed on any of alice's several wallets -- including ones an
-- earlier comment, written before that section ran, claimed he wasn't in.
-- A fresh wallet's membership history is exactly one row: the
-- owner-membership trigger (0002) adds alice, and nothing else ever
-- touches it. d0000000-...-001 is created strictly AFTER the Invitations
-- section's lookup already ran, so bob provably cannot hold membership in
-- it via that unordered select either.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('d0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
              'Alice Solo', 'card', 'USD', 3, 'credit-card');
    assert is_wallet_member('d0000000-0000-0000-0000-000000000001'::uuid) = true,
      'test setup broken: alice should be an owner-member of her own new wallet';
  end $$;
commit;

-- Bob -- not alice -- "creates" the budget (created_by = bob). Seeded here
-- at superuser scope, like every budgets/budget_wallets fixture in this
-- file since the C1 fix round (Task 2): budgets INSERT is no longer
-- granted to authenticated at all, so there is no impersonated path left
-- to exercise. created_by still carries no permission (0013's own
-- comment: "who can see this budget is decided entirely by its wallet set
-- ... never by created_by") -- which is exactly why a superuser can set it
-- to bob without bob ever having run the INSERT himself.
insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('b0000000-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002',
        'USD', null, '2026-10-01', 75000);

-- Seed the two-wallet set as the table-owning superuser, for the same
-- reason the C1 fixture above does: budget_wallets grants no INSERT to
-- authenticated (I2), and set_budget -- the intended path -- is Task 3's
-- job. This is setup, not the thing under test.
insert into public.budget_wallets (budget_id, wallet_id) values
  ('b0000000-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000003'),
  ('b0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001');

-- Positive control: alice is a member of BOTH wallets in the set -- and is
-- NOT the creator -- so she sees exactly one row. Paired with bob's denial
-- immediately below: under a wrong `created_by = auth.uid()` policy this
-- assertion would fail (alice made nothing here), which is the point.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
    assert (select count(*) from public.budgets where id = 'b0000000-0000-0000-0000-000000000003') = 1,
      'PERMISSION BROKEN: a member of every wallet in a multi-wallet set cannot read the budget';
  end $$;
commit;

-- THE core semantics assertion, now on two axes at once. Bob is the
-- budget's CREATOR, but a member of only ONE of the set's two wallets
-- (cccccccc-003, made a genuine member in the membership section above and
-- never revoked) and not the other (d0000000-...-001, alice's, never
-- shared with him). Visibility here tracks membership of every wallet in
-- the set, NOT creation: "visible to members of EVERY wallet" must deny
-- him despite his authorship, and a policy that only checked ANY
-- membership would let him through regardless of who made the row.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('cccccccc-0000-0000-0000-000000000003'::uuid) = true,
      'test setup broken: bob should still be a member of cccccccc-003';
    assert is_wallet_member('d0000000-0000-0000-0000-000000000001'::uuid) = false,
      'test setup broken: bob should not be a member of alice''s new solo wallet';
    assert (select count(*) from public.budgets where id = 'b0000000-0000-0000-0000-000000000003') = 0,
      'LEAK: the creator of a multi-wallet budget, a member of only ONE wallet in its set, can still read it -- the policy is checking ANY membership (or authorship), not EVERY-wallet membership';
  end $$;
commit;


-- =====================================================================
-- Budgets (0013): get_budget_status (Task 2). The sections above test RLS
-- on budgets/budget_wallets themselves (SELECT/INSERT/DELETE); this section
-- tests the SECURITY DEFINER aggregate that reports spending against a
-- budget. get_budget_status bypasses RLS by design, so its own `vis` CTE --
-- not the table's policy -- decides what this function returns; but as the
-- C1 fix round below establishes, that CTE is emphatically NOT the only
-- thing standing between a caller and a budget's data -- budget_visible
-- itself, called from BOTH `vis` and the table's own `budgets_visible`
-- policy, is. Every visibility case exercised above for budgets_visible /
-- budget_visible is re-exercised here against the function's own output,
-- since RLS agreeing does not prove this function agrees.
--
-- Every `budgets` row below is seeded at superuser scope, outside
-- impersonation, the same way every budget_wallets row already had to be
-- (I2): the C1 fix round revokes INSERT on budgets from authenticated
-- entirely, so there is no impersonated path left to create one. Wallets
-- and transactions, whose grants are untouched, are still created under
-- impersonation so ownership/membership triggers fire normally.
--
-- Dedicated wallets (the facade00-... prefix, unused anywhere else in this
-- file) and fixed 2026 calendar dates, never current_date, keep every
-- assertion below a closed-form computation: independent of when the suite
-- happens to run, and independent of the transaction history the sections
-- above already built up in cccccccc-003 and its siblings. Presence/absence
-- checks (count/found), rather than exact spent_minor, are used wherever a
-- shared fixture's full history is not being controlled here (block 3,
-- which reuses budget b0000000-...-003 from the section above).
-- =====================================================================

-- 1. Positive: Alice creates a budget over her own (fresh) wallet, with a
--    single in-range expense. get_budget_status must report it with the
--    right spent_minor and budget_minor.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet One', 'bank', 'USD', 1, 'landmark');

    insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
      values ('facade00-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
              'expense', -4200, 'USD', '2026-01-15');
  end $$;
commit;

insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('facade00-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-01-01', 200000);
insert into public.budget_wallets (budget_id, wallet_id) values
  ('facade00-0000-0000-0000-000000000101', 'facade00-0000-0000-0000-000000000001');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare r record;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
    select * into r from public.get_budget_status('2026-01-01','2026-01-31') g
      where g.budget_id = 'facade00-0000-0000-0000-000000000101';
    assert found, 'PERMISSION BROKEN: alice cannot see her own budget in get_budget_status';
    assert r.spent_minor = 4200, format('wrong spent_minor: %s', r.spent_minor);
    assert r.budget_minor = 200000, format('wrong budget_minor: %s', r.budget_minor);
    assert r.wallet_count = 1, format('wrong wallet_count: %s', r.wallet_count);
    assert r.wallet_names = array['GBS Wallet One'], format('wrong wallet_names: %s', r.wallet_names);
    assert r.currency_code = 'USD', 'wrong currency_code';
    assert r.budget_period_start = '2026-01-01'::date, 'wrong budget_period_start';
    -- M3 (not a bug -- documented, expected behaviour for the overall cap):
    -- category_key null must produce category_label null too. The
    -- category_label subquery matches on `lower(btrim(c.name)) =
    -- e.category_key`, and no category's name is ever NULL, so a NULL
    -- category_key can never match a row -- the subquery returns NULL and
    -- coalesce falls through to e.category_key, itself NULL.
    assert r.category_label is null, format('wrong category_label for an overall cap: %s', r.category_label);
  end $$;
commit;

-- 2. Denial + positive: Carol, a stranger to facade00-...-001, gets zero
--    rows for block 1's budget from get_budget_status; Alice still gets one.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    select count(*) into n from public.get_budget_status('2026-01-01','2026-01-31')
      where budget_id = 'facade00-0000-0000-0000-000000000101';
    assert n = 0, 'LEAK: a non-member sees a budget over a wallet she does not belong to via get_budget_status';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
    select count(*) into n from public.get_budget_status('2026-01-01','2026-01-31')
      where budget_id = 'facade00-0000-0000-0000-000000000101';
    assert n = 1,
      'PERMISSION BROKEN: alice cannot see her own budget in get_budget_status (paired with carol''s denial above)';
  end $$;
commit;

-- 3. Denial + positive, via get_budget_status: budget b0000000-...-003 (the
--    multi-wallet fixture from the RLS section above, spanning
--    {cccccccc-003, d0000000-001}, period 2026-10-01) is visible to Alice
--    (member of BOTH wallets), invisible to Bob (member of only
--    cccccccc-003) and to Carol (member of neither). Presence/absence is
--    what is asserted, not spent_minor -- cccccccc-003's transaction history
--    by this point in the file is exercised by other sections, not this
--    one, and category_key is null (an overall cap) so a value assertion
--    here would silently depend on it.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
    select count(*) into n from public.get_budget_status('2026-10-01','2026-10-31')
      where budget_id = 'b0000000-0000-0000-0000-000000000003';
    assert n = 1,
      'PERMISSION BROKEN: alice (member of every wallet in the set) cannot see the multi-wallet budget via get_budget_status';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    select count(*) into n from public.get_budget_status('2026-10-01','2026-10-31')
      where budget_id = 'b0000000-0000-0000-0000-000000000003';
    assert n = 0,
      'LEAK: bob (member of only ONE wallet in the set) sees the multi-wallet budget via get_budget_status';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    select count(*) into n from public.get_budget_status('2026-10-01','2026-10-31')
      where budget_id = 'b0000000-0000-0000-0000-000000000003';
    assert n = 0,
      'LEAK: carol (member of neither wallet in the set) sees the multi-wallet budget via get_budget_status';
  end $$;
commit;

-- 4. Empty-set: b0000000-...-002 is Alice's own budget from the I2 fixture
--    above, deliberately left with NO budget_wallets row -- this task's
--    hazard to close (folded into budget_visible itself, C1 fix round; see
--    0013's HAZARD comment above budget_visible's definition), not create
--    a second instance of.
--
--    C2 correction to an earlier draft of this block: get_budget_status's
--    own exclusion of this row is NOT the falsifiable protection for this
--    hazard. It is three-fold redundant beneath budget_visible -- `keyed`,
--    `spend`, and `scope` each independently INNER JOIN budget_wallets, so
--    disabling any ONE of them (or budget_visible itself) still would not
--    surface this budget through get_budget_status; confirmed by removing
--    the (now-deleted) standalone `exists (...)` clause that used to live
--    in this function's own `vis` CTE and observing the row still did NOT
--    appear (see task-2-report.md -- that transcript is what this comment
--    used to, wrongly, claim showed the opposite). The get_budget_status
--    assertions in this block are therefore NOT the falsifiable guard for
--    this hazard and must not be read as one.
--
--    The FALSIFIABLE assertion is the table-layer block further down:
--    before the C1 fix, budgets_visible's predicate (= budget_visible(id),
--    with no non-empty test) returned TRUE for this row regardless of who
--    asked, so it was readable -- and, until this same fix round revoked
--    INSERT, writable/deletable -- by ANY authenticated user via
--    PostgREST, not merely mis-reported by one aggregate function.
--    Reverting budget_visible's non-empty conjunct alone (leaving
--    keyed/spend/scope untouched) makes that block fail; see
--    task-2-report.md for the transcript.
--
--    A positive control in the SAME get_budget_status call is seeded and
--    asserted FIRST (C3), so the empty-set assertion below it cannot pass
--    merely because get_budget_status is broken and returns nothing for
--    everyone.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet Five', 'bank', 'USD', 7, 'landmark');
  end $$;
commit;

insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('facade00-0000-0000-0000-000000000107', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-09-01', 60000);
insert into public.budget_wallets (budget_id, wallet_id) values
  ('facade00-0000-0000-0000-000000000107', 'facade00-0000-0000-0000-000000000008');

-- Setup guard, OUTSIDE impersonation at superuser scope (C3): an
-- impersonated count would silently read 0 rows (looking like "still
-- empty") even if a future fixture attached a wallet the impersonated
-- user cannot see, since budget_wallets' own RLS (budget_wallets_member)
-- would hide that row from her -- masking exactly the regression this
-- guard exists to catch.
do $$ begin
  assert (select count(*) from public.budget_wallets
            where budget_id = 'b0000000-0000-0000-0000-000000000002') = 0,
    'test setup broken: b0000000-...-002 must still have no budget_wallets rows for this to test the empty-set hazard';
end $$;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    -- Positive control, in the SAME call as the empty-set assertion below:
    -- the wallet-FUL September budget IS returned.
    select count(*) into n from public.get_budget_status('2026-09-01','2026-09-30')
      where budget_id = 'facade00-0000-0000-0000-000000000107';
    assert n = 1, 'test setup broken: the wallet-FUL positive control was not returned by get_budget_status';

    -- The empty-set assertion. NOT the falsifiable guard -- see the
    -- comment above this block.
    select count(*) into n from public.get_budget_status('2026-09-01','2026-09-30')
      where budget_id = 'b0000000-0000-0000-0000-000000000002';
    assert n = 0, 'HAZARD OPEN: a wallet-less budget was reported by get_budget_status';
  end $$;
commit;

-- Table-layer denial (C1) -- THE falsifiable assertion for this hazard.
-- Carol, a total stranger to b0000000-...-002, reads it directly from
-- `budgets` (not through get_budget_status) and must get zero rows.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    select count(*) into n from public.budgets where id = 'b0000000-0000-0000-0000-000000000002';
    assert n = 0,
      'LEAK: carol can read a wallet-less budget directly from the budgets table -- the empty-set hazard is open at the RLS layer';
  end $$;
commit;

-- And the SAME holds for the budget's own CREATOR: budget_visible does not
-- special-case authorship, so 0013's "invisible to everyone, including the
-- creator" documentation is a real, tested claim, not just prose.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare n int;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
    select count(*) into n from public.budgets where id = 'b0000000-0000-0000-0000-000000000002';
    assert n = 0,
      'DOCUMENTATION MISMATCH: alice (the creator) can still read her own wallet-less budget directly -- 0013''s HAZARD comment claims this is invisible to everyone including the creator';
  end $$;
commit;

-- 5. Expenses-only: budgets register spending for kind = 'expense' ONLY --
--    the requester's defining constraint. A wallet holding an expense, an
--    income, and a real create_transfer pair must report only the expense.
--    WATCHED TO FAIL by temporarily removing `t.kind = 'expense'` from the
--    spend CTE's join (see task-2-report.md for the exact transcript).
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet Two', 'bank', 'USD', 2, 'landmark');
    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet Three', 'bank', 'USD', 3, 'landmark');

    insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
      values ('facade00-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
              'expense', -1500, 'USD', '2026-02-10');
    insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
      values ('facade00-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
              'income', 5000, 'USD', '2026-02-10');
    perform create_transfer('facade00-0000-0000-0000-000000000003', 'facade00-0000-0000-0000-000000000004',
                             2000, 2000, '2026-02-10', 'gbs test transfer');
  end $$;
commit;

insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('facade00-0000-0000-0000-000000000102', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-02-01', 300000);
insert into public.budget_wallets (budget_id, wallet_id) values
  ('facade00-0000-0000-0000-000000000102', 'facade00-0000-0000-0000-000000000003');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare spent bigint;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
    select spent_minor into spent from public.get_budget_status('2026-02-01','2026-02-28')
      where budget_id = 'facade00-0000-0000-0000-000000000102';
    assert found, 'test setup broken: block 5 budget not returned at all';
    assert spent = 1500,
      format('EXPENSES-ONLY BROKEN: spent_minor should count only the expense (1500, excluding the 5000 income and the 2000 transfer), got %s', spent);
  end $$;
commit;

-- 6. Carry-forward: September's budget (50000) governs September; raising
--    it for October (80000) must not rewrite September, and November --
--    with no budget of its own -- carries October's amount forward. Both
--    rows share the SAME wallet set (facade00-...-005 alone), which is
--    what makes them compete for the same (set_key, category_key) slot in
--    `eff` in the first place.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet Four', 'bank', 'USD', 4, 'landmark');
  end $$;
commit;

insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('facade00-0000-0000-0000-000000000103', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-09-01', 50000);
insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('facade00-0000-0000-0000-000000000104', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-10-01', 80000);
insert into public.budget_wallets (budget_id, wallet_id) values
  ('facade00-0000-0000-0000-000000000103', 'facade00-0000-0000-0000-000000000005'),
  ('facade00-0000-0000-0000-000000000104', 'facade00-0000-0000-0000-000000000005');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare r record;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    -- September: its own budget (50000), not October's. `into strict` (M1),
    -- not plain `into` + `assert found`: a plain `into` silently takes an
    -- arbitrary row if more than one matches, so if `distinct on` in `eff`
    -- ever regressed to letting both facade00-...-103 and -104 through for
    -- the same month, this would keep passing nondeterministically instead
    -- of raising TOO_MANY_ROWS.
    select * into strict r from public.get_budget_status('2026-09-10','2026-09-20') g
      where g.budget_id in ('facade00-0000-0000-0000-000000000103','facade00-0000-0000-0000-000000000104');
    assert r.budget_id = 'facade00-0000-0000-0000-000000000103'::uuid,
      format('CARRY-FORWARD BROKEN: September must use its own budget, got %s', r.budget_id);
    assert r.budget_minor = 50000, format('wrong September budget_minor: %s', r.budget_minor);
    assert r.budget_period_start = '2026-09-01'::date, 'wrong September budget_period_start';
    -- I2: no transactions exist for this wallet at all, so spent_minor must
    -- be a genuine zero, not absent -- the only fixture in this file that
    -- exercises `coalesce(sum(...), 0)` for real.
    assert r.spent_minor = 0, format('wrong September spent_minor: %s', r.spent_minor);

    -- November: no budget of its own -- must carry October's (80000) forward.
    select * into strict r from public.get_budget_status('2026-11-05','2026-11-10') g
      where g.budget_id in ('facade00-0000-0000-0000-000000000103','facade00-0000-0000-0000-000000000104');
    assert r.budget_id = 'facade00-0000-0000-0000-000000000104'::uuid,
      format('CARRY-FORWARD BROKEN: November must carry October''s budget forward, got %s', r.budget_id);
    assert r.budget_minor = 80000, format('wrong November (carried-forward) budget_minor: %s', r.budget_minor);
    assert r.budget_period_start = '2026-10-01'::date, 'wrong carried-forward budget_period_start';
  end $$;
commit;

-- 7. Overlap: two budgets on the SAME category (both the overall cap, i.e.
--    category_key null) but over DIFFERENT wallet sets -- {A} and {A,B} --
--    are independent rows in `eff` (different set_key), not competitors for
--    the same carry-forward slot. That is the feature this redesign adds,
--    not a bug: the wallet the two sets share (A) holds the only expense,
--    which both budgets independently report.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet A', 'bank', 'USD', 5, 'landmark');
    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet B', 'bank', 'USD', 6, 'landmark');

    insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, occurred_on)
      values ('facade00-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001',
              'expense', -3000, 'USD', '2026-04-10');
  end $$;
commit;

insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('facade00-0000-0000-0000-000000000105', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-04-01', 10000);
insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('facade00-0000-0000-0000-000000000106', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', null, '2026-04-01', 20000);
insert into public.budget_wallets (budget_id, wallet_id) values
  ('facade00-0000-0000-0000-000000000105', 'facade00-0000-0000-0000-000000000007'),
  ('facade00-0000-0000-0000-000000000106', 'facade00-0000-0000-0000-000000000007'),
  ('facade00-0000-0000-0000-000000000106', 'facade00-0000-0000-0000-000000000006');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare spent_a bigint; spent_b bigint;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    select spent_minor into spent_a from public.get_budget_status('2026-04-01','2026-04-30')
      where budget_id = 'facade00-0000-0000-0000-000000000105';
    assert found, 'OVERLAP BROKEN: single-wallet-set budget did not survive eff';
    select spent_minor into spent_b from public.get_budget_status('2026-04-01','2026-04-30')
      where budget_id = 'facade00-0000-0000-0000-000000000106';
    assert found,
      'OVERLAP BROKEN: two-wallet-set budget did not survive eff -- overlapping sets for the same category are being collapsed into one';

    assert spent_a = 3000, format('wrong spent_minor for the {A} budget: %s', spent_a);
    assert spent_b = 3000, format('wrong spent_minor for the {A,B} budget: %s', spent_b);
  end $$;
commit;

-- 8. I1 + I2: `uncovered`'s NOT EXISTS must be correlated to the WALLET,
--    not just the category key, and the design's category-matching path
--    (the `spend` CTE's WHERE clause, the categories JOIN, `uncovered`,
--    and category_label for a real category) needs at least one fixture
--    that actually exercises it -- every block above uses
--    category_key = null and category-less transactions, so all of that
--    code could be deleted with the suite still green until now.
--
--    Budget BG (facade00-...-108) covers Groceries over {W1} ONLY (W1 =
--    facade00-...-0009). W1 ALSO has an UNCATEGORISED expense (-500),
--    which must NOT count toward BG -- I2's target: deleting the `spend`
--    CTE's
--    `where t.id is null or c.id is not null or e.category_key is null`
--    line would fold it in, changing BG's spent_minor from 2000 to 2500.
--    Watched to fail; see task-2-report.md.
--
--    W2 (facade00-...-0010) -- NOT in BG's wallet set -- ALSO spends on
--    ITS OWN Groceries category (-700). Before I1's fix, an uncorrelated
--    `not exists (select 1 from eff e where e.category_key = 'groceries')`
--    treated "Groceries is budgeted somewhere" as covering W2 too, so this
--    700 was excluded from BOTH `spend` (wrong wallet) and `uncovered`
--    (category exists in eff) -- it vanished from the report entirely,
--    exactly the "money silently vanishes" bug this fix closes. Watched to
--    fail against the pre-fix uncorrelated form; see task-2-report.md.
--
--    Re-review addition: the -500 uncategorised expense above collapses to
--    the SAME `c.id is null` branch of the `spend` CTE's WHERE line as any
--    other non-matching row would, so it alone leaves
--    `and (e.category_key is null or lower(btrim(c.name)) = e.category_key)`
--    -- the ON-clause predicate that actually restricts `spend` to the
--    budget's OWN category, not merely to "has some category" -- deletable
--    with the suite still green. W1 also spends -800 on Eating out (a
--    DIFFERENT, real category, not uncategorised): BG's spent_minor must
--    still be 2000, not 2800, proving the ON-clause predicate stops a
--    `groceries` budget from silently absorbing Eating out (or Rent, or
--    any other category) spent in the same wallet. Watched to fail by
--    deleting that ON-clause predicate; see task-2-report.md.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare groceries_w1 uuid; groceries_w2 uuid; eating_out_w1 uuid;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet Six', 'bank', 'USD', 8, 'landmark');
    insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
      values ('facade00-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001',
              'GBS Wallet Seven', 'bank', 'USD', 1, 'wallet');

    select id into groceries_w1 from public.categories
      where wallet_id = 'facade00-0000-0000-0000-000000000009'
        and kind = 'expense' and lower(btrim(name)) = 'groceries';
    select id into groceries_w2 from public.categories
      where wallet_id = 'facade00-0000-0000-0000-000000000010'
        and kind = 'expense' and lower(btrim(name)) = 'groceries';
    select id into eating_out_w1 from public.categories
      where wallet_id = 'facade00-0000-0000-0000-000000000009'
        and kind = 'expense' and lower(btrim(name)) = 'eating out';
    assert groceries_w1 is not null and groceries_w2 is not null and eating_out_w1 is not null,
      'test setup broken: seed_wallet_categories did not create Groceries/Eating out for one of the block 8 wallets';

    insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
      values ('facade00-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001',
              'expense', -2000, 'USD', groceries_w1, '2026-05-10');
    insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
      values ('facade00-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001',
              'expense', -500, 'USD', null, '2026-05-12');
    insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
      values ('facade00-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001',
              'expense', -700, 'USD', groceries_w2, '2026-05-15');
    -- A DIFFERENT real category in W1 (not uncategorised): -800 on Eating
    -- out. Must not count toward BG (Groceries-only) -- see the comment
    -- above this block.
    insert into public.transactions (wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
      values ('facade00-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001',
              'expense', -800, 'USD', eating_out_w1, '2026-05-11');
  end $$;
commit;

insert into public.budgets (id, created_by, currency_code, category_key, period_start, amount_minor)
values ('facade00-0000-0000-0000-000000000108', 'aaaaaaaa-0000-0000-0000-000000000001',
        'USD', 'groceries', '2026-05-01', 50000);
insert into public.budget_wallets (budget_id, wallet_id) values
  ('facade00-0000-0000-0000-000000000108', 'facade00-0000-0000-0000-000000000009');

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare bg_spent bigint; bg_label text; uncov_spent bigint; uncov_label text;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    select spent_minor, category_label into bg_spent, bg_label
      from public.get_budget_status('2026-05-01','2026-05-31')
      where budget_id = 'facade00-0000-0000-0000-000000000108';
    assert found, 'test setup broken: block 8 budget not returned at all';
    assert bg_spent = 2000,
      format('I2/ON-CLAUSE BROKEN: BG''s spent_minor should exclude W1''s uncategorised -500 AND W1''s -800 Eating out (a real, DIFFERENT category) -- expect 2000, got %s', bg_spent);
    assert lower(btrim(bg_label)) = 'groceries',
      format('wrong category_label for a real category: %s', bg_label);

    select spent_minor, category_label into uncov_spent, uncov_label
      from public.get_budget_status('2026-05-01','2026-05-31')
      where budget_id is null and category_key = 'groceries';
    assert found,
      'I1 BROKEN: W2''s Groceries spending (budgeted only over W1) vanished instead of appearing in uncovered';
    assert uncov_spent = 700,
      format('I1 BROKEN: uncovered spent for W2''s groceries should be 700, got %s', uncov_spent);
    assert lower(btrim(uncov_label)) = 'groceries',
      format('wrong uncovered category_label: %s', uncov_label);
  end $$;
commit;

-- =====================================================================
-- Budgets (0013): set_budget (Task 3). set_budget is SECURITY DEFINER and
-- bypasses RLS on budgets/budget_wallets entirely, so -- unlike every other
-- section in this file -- impersonation here is NOT what stands between a
-- caller and someone else's data. The function's OWN guards are. This
-- section proves three things supabase/tests/constraints.sql cannot, since
-- that file runs as the table-owning superuser throughout:
--   1. the EXECUTE grant is actually scoped to `authenticated` (revoked from
--      anon/public) -- a superuser session bypasses function ACLs entirely,
--      so only a real role check catches a missing/wrong grant;
--   2. the membership guard holds against REAL wallet_members rows, added
--      through the ordinary owner-invites-member path, not rows inserted at
--      superuser scope for convenience;
--   3. the created_by = auth.uid() claim -- SECURITY DEFINER changes the
--      executing ROLE, not request.jwt.claims, but that is asserted here
--      against a genuinely impersonated session rather than taken on faith;
--   4. a budget set_budget creates is then actually visible, through
--      ordinary RLS, to the caller who created it -- closing the loop this
--      function's own comment opens ("bypasses budgets_visible entirely by
--      design" on write; read-back still goes through it).
-- The empty-array/mixed-currency/duplicate/overlap cases are already
-- covered in detail in constraints.sql (which exercises the function's own
-- logic directly); they are not re-proven here except where a real
-- impersonated caller adds something a superuser session cannot.
--
-- Fixtures: two of Alice's wallets sharing SGD, the second one genuinely
-- shared with Bob (owner-invites-member, not a superuser insert); a third,
-- Bob's own, that Alice never touches. 5e7b0000-... is a prefix unused
-- anywhere else in this file.
-- =====================================================================

do $$ begin
  assert has_function_privilege('authenticated', 'public.set_budget(text,date,bigint,uuid[])', 'EXECUTE'),
    'GRANT BROKEN: authenticated must be able to EXECUTE set_budget';
  assert not has_function_privilege('anon', 'public.set_budget(text,date,bigint,uuid[])', 'EXECUTE'),
    'LEAK: anon must not be able to EXECUTE set_budget';
  assert not has_function_privilege('public', 'public.set_budget(text,date,bigint,uuid[])', 'EXECUTE'),
    'LEAK: public must not be able to EXECUTE set_budget';
end $$;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
    ('5e7b0000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'SB Wallet One', 'bank', 'SGD', 1, 'landmark'),
    ('5e7b0000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'SB Wallet Two', 'bank', 'SGD', 2, 'wallet'),
    ('5e7b0000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'SB Wallet EUR', 'bank', 'EUR', 4, 'euro');

  -- Real membership, granted by the owner, not seeded at superuser scope --
  -- this is the row the membership-denial block below relies on being
  -- genuine.
  insert into public.wallet_members (wallet_id, user_id, role)
    values ('5e7b0000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'member');

  do $$ begin
    assert is_wallet_member('5e7b0000-0000-0000-0000-000000000001'::uuid) = true
       and is_wallet_member('5e7b0000-0000-0000-0000-000000000002'::uuid) = true,
      'test setup broken: alice should be a member of both her own wallets';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  insert into public.wallets (id, owner_id, name, kind, currency_code, color_slot, icon)
    values ('5e7b0000-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', 'Bob Solo', 'card', 'SGD', 3, 'credit-card');
commit;

-- Positive control: alice is a member of EVERY wallet in the submitted set.
-- Also proves created_by = the CALLER (not a caller-suppliable value -- the
-- function takes no such parameter, but this proves auth.uid() resolves
-- correctly under SECURITY DEFINER rather than trusting the comment that
-- says so) and that the created row is then readable back through ordinary
-- RLS, not just returned by the function call itself.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare v_id uuid; v_created_by uuid; v_seen int;
  begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';

    v_id := set_budget('rent', '2026-09-01', 120000,
      array['5e7b0000-0000-0000-0000-000000000001', '5e7b0000-0000-0000-0000-000000000002']::uuid[]);
    assert v_id is not null,
      'PERMISSION BROKEN: alice, a member of every wallet in the set, could not create a budget';

    select created_by into v_created_by from public.budgets where id = v_id;
    assert v_created_by = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      format('created_by should be the calling user (alice), got %s', v_created_by);

    select count(*) into v_seen from public.budgets where id = v_id;
    assert v_seen = 1,
      'PERMISSION BROKEN: alice cannot see, through ordinary RLS, the budget set_budget just created for her';
  end $$;
commit;

-- REVIEW FINDING (I1, IMPORTANT): every fixture up to this point has the
-- caller OWNING every wallet in the set she submits, so this suite could
-- not tell `is_wallet_member(w.id)` apart from `w.owner_id = auth.uid()` --
-- swap the guard to the latter and every earlier assertion still passes,
-- including Bob's denial below (he owns neither wallet either way). The
-- behaviour that matters most in production -- a non-owner MEMBER
-- budgeting over a wallet shared with them, not just its owner -- was never
-- exercised. Fixed here: Bob, who owns NEITHER wallet in the set but is a
-- genuine invited MEMBER of 5e7b0000-...-002 (added by alice, the owner,
-- via the real wallet_members insert above -- not a superuser seed), must
-- be able to budget over that wallet alone. Placed BEFORE the denial block
-- below so a reader sees the positive and negative controls on the same
-- membership fact in sequence: member of ...002 alone succeeds; member of
-- ...002 but not ...001 together is refused.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$
  declare v_id uuid;
  begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert (select owner_id from public.wallets where id = '5e7b0000-0000-0000-0000-000000000002') <> 'bbbbbbbb-0000-0000-0000-000000000002'::uuid,
      'test setup broken: bob must NOT own SB Wallet Two, only be a member of it, or this control proves nothing';

    v_id := set_budget('groceries', '2026-08-01', 15000,
      array['5e7b0000-0000-0000-0000-000000000002']::uuid[]);
    assert v_id is not null,
      'I1 REGRESSION: bob, a genuine non-owner MEMBER of SB Wallet Two, could not create a budget over it -- membership, not ownership, must be the standard';
  end $$;
commit;

-- THE guard that matters most (per the controller addendum for this task):
-- bob is a genuine member of ONLY ONE of the set's two wallets
-- (5e7b0000-...-002, via the real invite above) and not the other
-- (5e7b0000-...-001, alice's alone). Since set_budget runs with OWNER
-- RIGHTS, this guard -- not RLS -- is the only thing standing between bob
-- and a budget over alice's private wallet. Uses the same nested
-- begin/exception + flag pattern as constraints.sql, and for the same
-- reason: `when others` would otherwise swallow a deliberately-raised
-- "LEAK" exception and mask it as a wrong-message assertion instead.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$
  declare v_ok boolean := false;
  begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('5e7b0000-0000-0000-0000-000000000002'::uuid) = true,
      'test setup broken: bob should be a genuine member of SB Wallet Two';
    assert is_wallet_member('5e7b0000-0000-0000-0000-000000000001'::uuid) = false,
      'test setup broken: bob should not be a member of SB Wallet One';

    begin
      perform set_budget('rent', '2026-09-01', 999900,
        array['5e7b0000-0000-0000-0000-000000000001', '5e7b0000-0000-0000-0000-000000000002']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'not a member of every account in that set',
        format('wrong error for partial membership: %s', sqlerrm);
    end;
    assert not v_ok,
      'LEAK: bob, a member of only ONE wallet in the submitted set, created a budget covering the other -- set_budget''s membership guard did not hold under owner rights';
  end $$;
commit;

-- Confirm bob's rejected attempt left no trace: the exception unwound
-- set_budget before its INSERT ran (the membership guard is the first
-- thing checked after the null/positive-amount guards), so no row keyed to
-- amount 999900 should exist.
do $$ begin
  assert (select count(*) from public.budgets where amount_minor = 999900) = 0,
    'LEAK: a trace of bob''s rejected cross-membership budget attempt survived';
end $$;

-- REVIEW FINDING (C1, CRITICAL) -- the actual production exploit, not a
-- variant of the block above. array_length(p_wallet_ids, 1) measures only
-- the FIRST DIMENSION of the array; `= any(...)` and unnest(...) traverse
-- EVERY element regardless of dimensionality. A doubly-nested literal like
-- '{{w1,w2}}'::uuid[] -- one row of two columns, not two rows -- therefore
-- had array_length(...,1) = 1 while v_count (from `= any`) could also be 1
-- for a caller who is a genuine member of exactly ONE of the two wallets:
-- `1 <> 1` is false, so the OLD guard passed. This was proven, before the
-- fix, to reach set_budget over real PostgREST with an ordinary
-- authenticated JWT in three independent encodings: a nested JSON array, a
-- raw '{{...}}' Postgres array literal, and Prefer: params=single-object.
-- The flat-array test above does NOT exercise this path at all -- it is
-- why every test written before this review passed on the broken guard.
-- After the cardinality()-based fix, this must refuse with the SAME
-- membership message the flat form gets, since cardinality() and unnest()
-- now agree on "every element, regardless of dimension".
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$
  declare v_ok boolean := false;
  begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';

    begin
      -- A genuine 1x2 nested array, NOT array[array[...]] written out long-
      -- hand -- the literal-string form is what a raw '{{...}}' payload
      -- over PostgREST actually deserializes to, and is the exact shape
      -- array_length(...,1) miscounted.
      perform set_budget('rent', '2026-09-01', 999901,
        '{{5e7b0000-0000-0000-0000-000000000002,5e7b0000-0000-0000-0000-000000000001}}'::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'not a member of every account in that set',
        format('wrong error for nested-array partial membership: %s', sqlerrm);
    end;
    assert not v_ok,
      'C1 CRITICAL: bob, a member of only ONE wallet, created (or updated) a budget over a NESTED wallet array covering the other -- array_length(...,1) undercounts a nested array while unnest()/ANY do not';
  end $$;
commit;

do $$ begin
  assert (select count(*) from public.budgets where amount_minor = 999901) = 0,
    'C1 CRITICAL: a trace of bob''s rejected nested-array cross-membership attempt survived';
end $$;

-- Empty array and mixed-currency guards, re-proven here under a genuinely
-- impersonated caller (constraints.sql proves these against the function's
-- own logic; this confirms the same guards fire when reached through the
-- real authenticated role, not a superuser session with borrowed claims).
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('utilities', '2026-09-01', 5000, array[]::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'a budget must cover at least one account',
        format('wrong error for empty array: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget accepted an empty wallet array under real impersonation';
  end $$;

  do $$
  declare v_ok boolean := false;
  begin
    begin
      perform set_budget('utilities', '2026-09-01', 5000,
        array['5e7b0000-0000-0000-0000-000000000001', '5e7b0000-0000-0000-0000-000000000004']::uuid[]);
      v_ok := true;
    exception when others then
      assert sqlerrm = 'every account in a budget must use the same currency',
        format('wrong error for mixed currency: %s', sqlerrm);
    end;
    assert not v_ok, 'GUARD BROKEN: set_budget accepted a mixed-currency wallet set under real impersonation';
  end $$;

  -- Idempotency and overlap, once each, as a real-role sanity check that
  -- the read-modify-write path (not just the guards) survives contact with
  -- an actually-impersonated session rather than a superuser one.
  do $$
  declare v_id1 uuid; v_id2 uuid; v_rows int;
  begin
    v_id1 := set_budget('subscriptions', '2026-09-01', 2000,
      array['5e7b0000-0000-0000-0000-000000000001']::uuid[]);
    v_id2 := set_budget('subscriptions', '2026-09-01', 3500,
      array['5e7b0000-0000-0000-0000-000000000001']::uuid[]);
    assert v_id1 = v_id2,
      'IDEMPOTENCY BROKEN: repeat call for the same set/category/month returned a different budget id';
    -- REVIEW FINDING (I2): count by category_key/period_start, NOT `and id
    -- = v_id1` (an earlier draft did) -- filtering by primary key makes the
    -- count structurally 0 or 1 regardless of whether a duplicate landed,
    -- which is exactly the failure this count exists to catch.
    select count(*) into v_rows from public.budgets
      where category_key = 'subscriptions' and period_start = '2026-09-01';
    assert v_rows = 1, format('IDEMPOTENCY BROKEN: expected exactly 1 row, found %s', v_rows);
    assert (select amount_minor from public.budgets where id = v_id1) = 3500,
      'IDEMPOTENCY BROKEN: row should carry the second call''s amount';

    v_id2 := set_budget('subscriptions', '2026-09-01', 4000,
      array['5e7b0000-0000-0000-0000-000000000002']::uuid[]);
    assert v_id1 <> v_id2,
      'OVERLAP BROKEN: same category/month over a DIFFERENT wallet set collapsed onto the same budget';
  end $$;
commit;

-- =====================================================================
-- 0015: recurring_rules / recurring_skips RLS. Reuses cccccccc-003
-- (Alice Bank) -- by this point in the file bob is already a genuine
-- member of it (section 8) and carol has never touched it (she is only
-- a member of 40404040-...-040, Alice's Invite Wallet -- section 11), so
-- both actors are already in exactly the state this needs: bob a real
-- co-member, carol a real stranger. dddddddd-004 ('Custom Category',
-- kind expense) is cccccccc-003's own category, created in section 1.
--
-- Alice creates the rule, as its owner-side setup.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  insert into public.recurring_rules
      (id, wallet_id, created_by, name, kind, amount_minor, currency_code,
       category_id, interval_unit, anchor_on)
    values ('60606060-0000-0000-0000-000000000060', 'cccccccc-0000-0000-0000-000000000003',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Rent', 'expense', -150000, 'USD',
            'dddddddd-0000-0000-0000-000000000004', 'monthly', '2026-01-01');

  do $$ begin
    assert (select count(*) from public.recurring_rules
              where id = '60606060-0000-0000-0000-000000000060') = 1,
      'PERMISSION BROKEN: alice (owner) cannot create a recurring rule on her own wallet';
  end $$;
commit;

-- A non-member (carol) sees no rules and can create none.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    assert (select count(*) from public.recurring_rules) = 0,
      'LEAK: carol (a stranger to cccccccc-003) can see alice''s recurring rule';
  end $$;

  do $$
  begin
    insert into public.recurring_rules
        (wallet_id, created_by, name, kind, amount_minor, currency_code,
         category_id, interval_unit, anchor_on)
      values ('cccccccc-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000009',
              'Forged', 'expense', -100, 'USD', 'dddddddd-0000-0000-0000-000000000004',
              'monthly', current_date);
    raise exception 'LEAK: carol created a recurring rule on a wallet she is not a member of';
  exception
    when insufficient_privilege then
      null; -- expected: WITH CHECK on recurring_rules_member rejects it
  end $$;

  do $$
  begin
    insert into public.recurring_skips (rule_id, occurrence_on, created_by)
      values ('60606060-0000-0000-0000-000000000060', '2026-01-01',
              'cccccccc-0000-0000-0000-000000000009');
    raise exception 'LEAK: carol skipped an occurrence of alice''s recurring rule';
  exception
    when insufficient_privilege then
      null; -- expected: WITH CHECK on recurring_skips_member rejects it (the
            -- exists-subquery over recurring_rules finds no visible row)
  end $$;
commit;

-- Verify from alice's side that carol's attempts left no trace.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select count(*) from public.recurring_rules
              where wallet_id = 'cccccccc-0000-0000-0000-000000000003') = 1,
      'LEAK: recurring_rules row count changed after carol''s rejected insert attempt';
    assert (select count(*) from public.recurring_skips
              where rule_id = '60606060-0000-0000-0000-000000000060') = 0,
      'LEAK: a skip row exists after carol''s rejected insert attempt';
  end $$;
commit;

-- The load-bearing case: a co-member of the shared wallet (bob, a genuine
-- member of cccccccc-003 since section 8) sees the rule and MAY skip it.
-- Proving this, not only carol's denial above, is what distinguishes a
-- correct membership policy from one that simply denies everybody --
-- a suite with only the non-member case would pass identically against
-- either.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('cccccccc-0000-0000-0000-000000000003'::uuid) = true,
      'test setup broken: bob should already be a member of cccccccc-003 by this point in the file';
    assert (select count(*) from public.recurring_rules
              where wallet_id = 'cccccccc-0000-0000-0000-000000000003') = 1,
      'PERMISSION BROKEN: co-member bob cannot see alice''s recurring rule on the shared wallet';
  end $$;

  insert into public.recurring_skips (rule_id, occurrence_on, created_by)
    values ('60606060-0000-0000-0000-000000000060', '2026-01-01',
            'bbbbbbbb-0000-0000-0000-000000000002');

  do $$ begin
    assert (select count(*) from public.recurring_skips
              where rule_id = '60606060-0000-0000-0000-000000000060'
                and occurrence_on = '2026-01-01') = 1,
      'PERMISSION BROKEN: co-member bob cannot skip an occurrence of alice''s recurring rule';
  end $$;
commit;

-- =====================================================================
-- Fix 1 (task-2-fix-1, CRITICAL) -- a co-member must not be able to steal
-- a recurring rule by reassigning its wallet_id. This is the round-1
-- vulnerability, transactions' own precedent restated for recurring_rules:
-- recurring_rules_member is `for all using (is_wallet_member(wallet_id))
-- with check (is_wallet_member(wallet_id))`, so on UPDATE both clauses ask
-- the identical membership question -- one against the OLD row, one
-- against the NEW -- and a caller who is a member of TWO wallets satisfies
-- both while moving a row between them. Bob is exactly that caller here:
-- a real co-member of cccccccc-003 (section 8) AND owner (hence member, via
-- add_owner_as_member()) of his own ffffffff-006 (section 5) -- so this is
-- the live attack, not a contrived setup. The column-privilege grant this
-- fix adds (0015_recurring.sql, mirroring 0004_rls.sql's UPDATE grant on
-- transactions) is what has to stop it; RLS alone cannot, for the reason
-- above.
--
-- DISCRIMINATION CHECK (per task-2-fix-1-brief.md): this assertion was
-- verified to actually FAIL when 0015's blanket
-- `grant select, insert, update, delete on recurring_rules to
-- authenticated` was temporarily restored (i.e. before the column-scoped
-- revoke/grant fix) -- `npm run test:rls` failed here with "LEAK: co-member
-- bob reassigned alice's recurring rule to his own wallet via wallet_id",
-- exactly the finding the reviewer proved live. See task-2-fix-1-report.md
-- for both observed outputs (vulnerable-grant FAIL, fixed-grant PASS).
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('cccccccc-0000-0000-0000-000000000003'::uuid) = true,
      'test setup broken: bob should already be a co-member of cccccccc-003 (alice''s rule''s wallet)';
    assert is_wallet_member('ffffffff-0000-0000-0000-000000000006'::uuid) = true,
      'test setup broken: bob should already be a member (owner) of his own ffffffff-006';
  end $$;

  -- category_id is set IN THE SAME STATEMENT, to a4a4a4a4-002 ("Bob
  -- Category", inserted earlier in this file for ffffffff-006) -- not
  -- because a real attacker would bother, but because leaving category_id
  -- untouched would make this UPDATE collide with Fix 2's OWN protection
  -- (recurring_rules_category_same_wallet: dddddddd-004 belongs to
  -- cccccccc-003, not ffffffff-006) and fail with 23503 regardless of
  -- whether the column-privilege fix under test is present. category_id IS
  -- in the allowed-columns grant (it's a legitimate field to edit), so
  -- supplying a valid one isolates this assertion to wallet_id specifically
  -- -- the column that must never be reachable, fixed grant or not.
  do $$
  begin
    update public.recurring_rules
      set wallet_id = 'ffffffff-0000-0000-0000-000000000006',
          category_id = 'a4a4a4a4-0000-0000-0000-000000000002'
      where id = '60606060-0000-0000-0000-000000000060';
    raise exception 'LEAK: co-member bob reassigned alice''s recurring rule to his own wallet via wallet_id';
  exception
    when insufficient_privilege then
      null; -- expected, COLUMN PRIVILEGE: authenticated has no UPDATE grant on wallet_id
  end $$;

  -- Same attack, one column over: created_by re-attribution.
  do $$
  begin
    update public.recurring_rules set created_by = 'bbbbbbbb-0000-0000-0000-000000000002'
      where id = '60606060-0000-0000-0000-000000000060';
    raise exception 'LEAK: co-member bob re-attributed alice''s recurring rule to himself via created_by';
  exception
    when insufficient_privilege then
      null; -- expected, COLUMN PRIVILEGE: authenticated has no UPDATE grant on created_by
  end $$;

  -- Positive control, shape-identical to both attacks above (same user,
  -- same row -- only the column touched differs): bob CAN update an
  -- allowed column on the very same rule, proving the two denials above are
  -- the column grant specifically, not a broken session or an unreachable
  -- table.
  update public.recurring_rules set name = 'Rent (edited by bob)'
    where id = '60606060-0000-0000-0000-000000000060';
  do $$ begin
    assert (select name from public.recurring_rules where id = '60606060-0000-0000-0000-000000000060')
             = 'Rent (edited by bob)',
      'PERMISSION BROKEN (COLUMN PRIVILEGE): co-member bob cannot update an allowed column (name)';
  end $$;
commit;

-- Verify from alice's side that the wallet_id/created_by attacks left no
-- trace: the rule is still hers, on her wallet, only the name (an allowed
-- column) changed.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select wallet_id from public.recurring_rules where id = '60606060-0000-0000-0000-000000000060')
             = 'cccccccc-0000-0000-0000-000000000003'::uuid,
      'LEAK: recurring rule wallet_id changed despite the denied UPDATE';
    assert (select created_by from public.recurring_rules where id = '60606060-0000-0000-0000-000000000060')
             = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'LEAK: recurring rule created_by changed despite the denied UPDATE';
    -- The whole-statement rejection must have left category_id untouched
    -- too, even though category_id is itself an allowed column -- Postgres
    -- rejects the ENTIRE UPDATE when any targeted column lacks privilege,
    -- not just the offending column.
    assert (select category_id from public.recurring_rules where id = '60606060-0000-0000-0000-000000000060')
             = 'dddddddd-0000-0000-0000-000000000004'::uuid,
      'LEAK: recurring rule category_id changed despite the whole UPDATE being denied on wallet_id';
    assert (select count(*) from public.recurring_rules
              where wallet_id = 'ffffffff-0000-0000-0000-000000000006') = 0,
      'LEAK: alice''s rule (or a copy of it) now exists under bob''s wallet';
  end $$;
commit;

-- =====================================================================
-- 0016_editable_transactions: merchant's new UPDATE grant on transactions.
-- Reuses cccccccc-003, where by this point in the file bob is a genuine
-- co-member (section 8) and carol is a genuine stranger to it (proven
-- absent throughout sections 9 and 11) -- real membership state, not a
-- contrived setup. dddddddd-004 ('Custom Category', kind expense) is
-- cccccccc-003's own category, created in section 1. ffffffff-006 ('Bob
-- Bank') is bob's own wallet, created in section 5, reused below as the
-- wallet_id-reassignment target so the attack is genuinely reachable (bob
-- really does own a second wallet to try to move the row into).
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('61616161-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
            'expense', -450, 'USD', 'dddddddd-0000-0000-0000-000000000004', current_date);
commit;

-- Non-member carol's update must affect zero rows.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000009","email":"carol@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'cccccccc-0000-0000-0000-000000000009'::uuid, 'impersonation failed';
    assert is_wallet_member('cccccccc-0000-0000-0000-000000000003'::uuid) = false,
      'test setup broken: carol should not be a member of cccccccc-003';
  end $$;

  do $$
  declare n int;
  begin
    update transactions set merchant = 'Pwned Merchant'
      where id = '61616161-0000-0000-0000-000000000001';
    get diagnostics n = row_count;
    assert n = 0, 'LEAK: non-member carol updated merchant on alice''s transaction';
  end $$;
commit;

-- Co-member bob's update succeeds -- the load-bearing half: a suite that
-- only proves a stranger is blocked cannot tell a correct policy from one
-- that denies everybody. Also proves wallet_id stays refused for merchant's
-- new grant, exactly as section 10 already proved for the pre-existing
-- grant: the column list is what closed the proven privilege escalation
-- 0004_rls.sql's own comment describes, and adding merchant to it must not
-- have widened it any further.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('cccccccc-0000-0000-0000-000000000003'::uuid) = true,
      'test setup broken: bob should be a co-member of cccccccc-003 by now';
  end $$;

  update transactions set merchant = 'Corner Store'
    where id = '61616161-0000-0000-0000-000000000001';
  do $$ begin
    assert (select merchant from transactions where id = '61616161-0000-0000-0000-000000000001') = 'Corner Store',
      'PERMISSION BROKEN: co-member bob cannot update merchant on the shared wallet''s transaction';
  end $$;

  do $$
  begin
    update transactions set wallet_id = 'ffffffff-0000-0000-0000-000000000006'
      where id = '61616161-0000-0000-0000-000000000001';
    raise exception 'LEAK: co-member bob reassigned a transaction''s wallet_id via the same UPDATE path merchant now uses';
  exception
    when insufficient_privilege then
      null; -- expected, COLUMN PRIVILEGE: authenticated has no UPDATE grant on wallet_id
  end $$;
commit;

-- Verify from alice's side that carol's rejected attempt and bob's rejected
-- wallet_id attempt both left no trace beyond bob's legitimate merchant edit.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select merchant from transactions where id = '61616161-0000-0000-0000-000000000001') = 'Corner Store',
      'LEAK: merchant changed by carol''s rejected non-member update';
    assert (select wallet_id from transactions where id = '61616161-0000-0000-0000-000000000001')
             = 'cccccccc-0000-0000-0000-000000000003'::uuid,
      'LEAK: wallet_id changed despite bob''s denied UPDATE';
  end $$;
commit;

-- =====================================================================
-- Task 4 fix round 1: update_transfer_pair (0016_editable_transactions.sql)
-- adversarial + positive coverage, mirroring create_transfer's own Task 9
-- section above for the identical reason -- this is a new SECURITY
-- INVOKER function that moves money, and it had no adversarial coverage of
-- its own before this round. A suite proving only that a stranger is
-- blocked cannot distinguish a correct policy from one that denies
-- everybody, so the positive half (a genuine member succeeds) is proven
-- here too, exactly like every other section in this file.
--
-- Fresh wallets (a4a40000-...), not a reuse of cccccccc-003/77777777-007:
-- those wallets' transaction counts are asserted to an EXACT number by
-- several blocks earlier in this file (e.g. "count(*) ... = 3"), and
-- adding more transfer legs to them here would silently break those counts
-- for anyone editing this file later -- the same reasoning the Task 9
-- section's own comment gives for using 77777777-007/88888888-008 instead
-- of cccccccc-003 for ITS cross-currency control.
--
-- The two transfer legs per pair are inserted directly with fixed ids,
-- rather than through create_transfer (whose id is a fresh
-- gen_random_uuid() this file has no established way to capture across
-- separate impersonated transactions) -- the same fixed-id-across-blocks
-- technique the recurring_rules section (60606060-...) and the merchant
-- section (61616161-...) immediately above already use, for the identical
-- reason: this section needs one stable transfer_id visible across several
-- separate `begin;...commit;` blocks (setup as alice, attack as bob,
-- verify as alice, edit as alice, attack as alice again).
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
    ('a4a40000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Task4 A', 'bank', 'USD', 5, 'wallet'),
    ('a4a40000-0000-0000-0000-00000000a002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Task4 B', 'bank', 'USD', 6, 'wallet'),
    ('a4a40000-0000-0000-0000-00000000a003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Task4 C', 'bank', 'EUR', 7, 'wallet');

  -- Same-currency pair (A -> B, USD/USD, balanced 5000/5000) -- used for
  -- the membership attack/positive-control pair and the unbalanced-edit
  -- attack below.
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, transfer_id, occurred_on) values
    ('a4a40000-0000-0000-0000-0000000e0001', 'a4a40000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer', -5000, 'USD', 'a4a40000-0000-0000-0000-0000000f0001', current_date),
    ('a4a40000-0000-0000-0000-0000000e0002', 'a4a40000-0000-0000-0000-00000000a002', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer',  5000, 'USD', 'a4a40000-0000-0000-0000-0000000f0001', current_date);

  -- Cross-currency pair (A -> C, USD/EUR, independently valued 10000/9200)
  -- -- the control paired with the unbalanced-edit attack below.
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, transfer_id, occurred_on) values
    ('a4a40000-0000-0000-0000-0000000e0003', 'a4a40000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer', -10000, 'USD', 'a4a40000-0000-0000-0000-0000000f0002', current_date),
    ('a4a40000-0000-0000-0000-0000000e0004', 'a4a40000-0000-0000-0000-00000000a003', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer',   9200, 'EUR', 'a4a40000-0000-0000-0000-0000000f0002', current_date);
commit;

-- Attack: bob is a member of NEITHER a4a40000-...-a001 nor -a002 -- must
-- not be able to edit the same-currency pair at all. update_transfer_pair
-- is security invoker, so the SELECTs inside it that determine each leg's
-- currency run under BOB's own transactions_member RLS -- both rows are
-- invisible to him, so the function's own "incomplete pair" branch fires
-- and it returns the empty set, the identical outcome a genuinely missing
-- transfer_id would produce (updateTransfer's own doc comment in
-- src/server/actions/transactions.ts already documents this).
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('a4a40000-0000-0000-0000-00000000a001'::uuid) = false,
      'test setup broken: bob should not be a member of Task4 A';
    assert is_wallet_member('a4a40000-0000-0000-0000-00000000a002'::uuid) = false,
      'test setup broken: bob should not be a member of Task4 B';
  end $$;

  do $$
  declare n int;
  begin
    select count(*) into n from update_transfer_pair(
      'a4a40000-0000-0000-0000-0000000f0001', 6000, 6000, current_date, 'pwned', 'pwned');
    assert n = 0, 'LEAK: non-member bob edited a transfer pair he has no access to';
  end $$;
commit;

-- Verify from alice's side that bob's attempt left no trace.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0001') = -5000,
      'LEAK: non-member bob''s rejected call changed the out-leg''s amount';
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0002') = 5000,
      'LEAK: non-member bob''s rejected call changed the in-leg''s amount';
    assert (select note from transactions where id = 'a4a40000-0000-0000-0000-0000000e0001') is null,
      'LEAK: non-member bob''s rejected call wrote a note';
  end $$;
commit;

-- Positive control -- the load-bearing half: a suite proving only that a
-- stranger is blocked cannot distinguish a correct policy from one that
-- denies everybody. Alice, a genuine member of both wallets (owner of
-- both, via add_owner_as_member()), successfully edits the same-currency
-- pair, balanced 6000/6000.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare legs int;
  begin
    select count(*) into legs from update_transfer_pair(
      'a4a40000-0000-0000-0000-0000000f0001', 6000, 6000, current_date, 'edited', 'Bank');
    assert legs = 2, 'PERMISSION BROKEN: member alice could not edit her own transfer pair';
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0001') = -6000,
      'out-leg amount not updated';
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0002') = 6000,
      'in-leg amount not updated';
    assert (select note from transactions where id = 'a4a40000-0000-0000-0000-0000000e0001') = 'edited',
      'note not updated on the out-leg';
    assert (select note from transactions where id = 'a4a40000-0000-0000-0000-0000000e0002') = 'edited',
      'note not updated on the in-leg';
  end $$;
commit;

-- Control, paired with the unbalanced-edit attack below: a genuine
-- CROSS-currency edit with two genuinely different amounts must still
-- succeed -- the critical control for the balance guard, mirroring
-- create_transfer's own "Control, paired with the unbalanced-transfer
-- attacks below" section (Task 9, above). A guard written to reject
-- everything (not just same-currency mismatches) would pass the attack
-- test below and look identical to a correct fix unless this also runs
-- and passes.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare legs int; out_amt bigint; in_amt bigint;
  begin
    select count(*) into legs from update_transfer_pair(
      'a4a40000-0000-0000-0000-0000000f0002', 12000, 11000, current_date, 'fx edit', null);
    assert legs = 2, 'cross-currency edit must update exactly two legs';
    select amount_minor into out_amt from transactions where id = 'a4a40000-0000-0000-0000-0000000e0003';
    select amount_minor into in_amt  from transactions where id = 'a4a40000-0000-0000-0000-0000000e0004';
    assert out_amt = -12000, format('cross-currency out-leg wrong: %s', out_amt);
    assert in_amt  =  11000, format('cross-currency in-leg wrong: %s', in_amt);
  end $$;
commit;

-- Attack: update_transfer_pair must reject an UNBALANCED same-currency
-- edit. Both a4a40000-...-a001 and -a002 are USD, so amount_out <>
-- amount_in has no exchange rate to justify it -- it would either destroy
-- money (out > in) or fabricate it (out < in) with no error and no record.
-- Tested in both directions, mirroring create_transfer's own identical
-- attack pair (Task 9, above). THIS is the block whose discrimination was
-- verified by temporarily removing the balance check from
-- update_transfer_pair, re-running `npm run test:rls`, watching it fail,
-- and restoring -- see this task's report for both observed outputs.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  begin
    begin
      perform update_transfer_pair(
        'a4a40000-0000-0000-0000-0000000f0001', 7000, 1, current_date, null, null);
      raise exception 'LEAK: update_transfer_pair allowed an unbalanced same-currency edit (destroys money)';
    exception
      when others then
        assert sqlerrm = 'a same-currency transfer must balance',
          format('wrong rejection reason: %s', sqlerrm);
    end;

    begin
      perform update_transfer_pair(
        'a4a40000-0000-0000-0000-0000000f0001', 1, 7000, current_date, null, null);
      raise exception 'LEAK: update_transfer_pair allowed an unbalanced same-currency edit (fabricates money)';
    exception
      when others then
        assert sqlerrm = 'a same-currency transfer must balance',
          format('wrong rejection reason: %s', sqlerrm);
    end;
  end $$;
commit;

-- Verify the unbalanced attack left the pair exactly as the positive
-- control above left it (6000/6000) -- no before/after row-count assertion
-- is needed around either caught raise above (the same "a raised call
-- inside a plpgsql exception block rolls back its implicit subtransaction"
-- reasoning the Task 9 section's own comment gives for create_transfer's
-- identical attack shape); this is the assertion that actually proves
-- nothing persisted.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0001') = -6000,
      'LEAK: unbalanced attack changed the out-leg despite being rejected';
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0002') = 6000,
      'LEAK: unbalanced attack changed the in-leg despite being rejected';
  end $$;
commit;

-- =====================================================================
-- Task 4 fix round 2, FIX 1: update_transfer_pair's PARTIAL-membership
-- guard (0016_editable_transactions.sql, the `if out_ccy is null or
-- in_ccy is null then return; end if;` block) had no regression coverage.
-- The block above this one only proves a caller who is a member of
-- NEITHER wallet is refused -- in that case BOTH out_ccy and in_ccy come
-- back NULL, so the guard's `or` is satisfied by either arm alone, and a
-- reviewer who deleted the guard entirely still saw that block pass
-- (RLS's own `using (is_wallet_member(wallet_id))` on the UPDATE below
-- still empty-matches for a total stranger, independent of this guard).
-- A caller who is a member of ONE of the two wallets is a materially
-- different case: exactly one of out_ccy/in_ccy comes back non-NULL, so
-- only ONE arm of the `or` is doing any work, and removing the guard lets
-- the UPDATE's own RLS filter (not this function) silently narrow the
-- write to the one leg the caller can see -- a single-leg write that
-- destroys or fabricates money depending on which side was visible.
--
-- A fresh wallet (a4a40000-...-a004, "Task4 D"), not a reuse of
-- -a001/-a002/-a003: this needs a wallet BOB is a real member of (the
-- other three are Alice-only), and reusing -a001/-a002 here would add
-- extra transactions to wallets whose row-by-id assertions elsewhere in
-- this file don't expect them -- the identical reasoning the Task 4
-- section's own opening comment gives for not reusing cccccccc-003.
--
-- Two new pairs, not one, to cover BOTH arms of the `or`: f0003 puts the
-- wallet bob belongs to (a004) on the OUTGOING leg (so in_ccy is the NULL
-- one), f0004 puts it on the INCOMING leg (so out_ccy is the NULL one).
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  insert into wallets (id, owner_id, name, kind, currency_code, color_slot, icon) values
    ('a4a40000-0000-0000-0000-00000000a004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Task4 D', 'bank', 'USD', 8, 'wallet');

  -- Bob is a REAL member here (members_write's owner-only `with check`,
  -- proven working back in section 8) -- not a superuser seed, so this
  -- exercises the identical is_wallet_member() path update_transfer_pair's
  -- own internal SELECTs run through.
  insert into public.wallet_members (wallet_id, user_id, role)
    values ('a4a40000-0000-0000-0000-00000000a004', 'bbbbbbbb-0000-0000-0000-000000000002', 'member');

  -- f0003: bob's wallet (a004) holds the OUTGOING leg, Alice-only a001
  -- holds the INCOMING leg -- in_ccy will be the NULL one.
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, transfer_id, occurred_on) values
    ('a4a40000-0000-0000-0000-0000000e0005', 'a4a40000-0000-0000-0000-00000000a004', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer', -8000, 'USD', 'a4a40000-0000-0000-0000-0000000f0003', current_date),
    ('a4a40000-0000-0000-0000-0000000e0006', 'a4a40000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer',  8000, 'USD', 'a4a40000-0000-0000-0000-0000000f0003', current_date);

  -- f0004: Alice-only a001 holds the OUTGOING leg, bob's wallet (a004)
  -- holds the INCOMING leg -- out_ccy will be the NULL one.
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, transfer_id, occurred_on) values
    ('a4a40000-0000-0000-0000-0000000e0007', 'a4a40000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer', -3000, 'USD', 'a4a40000-0000-0000-0000-0000000f0004', current_date),
    ('a4a40000-0000-0000-0000-0000000e0008', 'a4a40000-0000-0000-0000-00000000a004', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer',  3000, 'USD', 'a4a40000-0000-0000-0000-0000000f0004', current_date);
commit;

-- Attack, direction 1: bob is a member of a004 (the OUTGOING leg's
-- wallet) but NOT a001 (the INCOMING leg's wallet). Removing the guard
-- would leave the UPDATE's own row-level RLS to narrow the write to just
-- the leg bob can see -- here, the outgoing leg alone -- destroying
-- money by moving only that leg's amount while the far leg stays put.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('a4a40000-0000-0000-0000-00000000a004'::uuid) = true,
      'test setup broken: bob should be a member of Task4 D';
    assert is_wallet_member('a4a40000-0000-0000-0000-00000000a001'::uuid) = false,
      'test setup broken: bob should not be a member of Task4 A';
  end $$;

  do $$
  declare n int;
  begin
    select count(*) into n from update_transfer_pair(
      'a4a40000-0000-0000-0000-0000000f0003', 1, 1, current_date, 'pwned-out', 'pwned-out');
    assert n = 0, 'LEAK: bob (member of only the OUTGOING leg''s wallet) edited a transfer pair he does not fully own';
  end $$;
commit;

-- Verify from alice's side that direction 1's attempt left BOTH legs
-- untouched -- this is the assertion that actually distinguishes "the
-- guard blocked it" from "the guard is gone but the RLS-narrowed UPDATE
-- happened to touch nothing anyway".
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0005') = -8000,
      'LEAK: partial-member bob''s rejected call changed the (visible-to-him) outgoing leg''s amount';
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0006') = 8000,
      'LEAK: partial-member bob''s rejected call changed the (invisible-to-him) incoming leg''s amount';
    assert (select note from transactions where id = 'a4a40000-0000-0000-0000-0000000e0005') is null,
      'LEAK: partial-member bob''s rejected call wrote a note onto the visible leg';
  end $$;
commit;

-- Attack, direction 2: bob is a member of a004 (the INCOMING leg's
-- wallet here) but NOT a001 (the OUTGOING leg's wallet). This exercises
-- the OTHER arm of the guard's `or` -- out_ccy is the NULL one this time
-- -- and, without the guard, would fabricate money by moving only the
-- incoming leg's amount up while the far (outgoing) leg stays put.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"bob@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  do $$
  declare n int;
  begin
    select count(*) into n from update_transfer_pair(
      'a4a40000-0000-0000-0000-0000000f0004', 1, 1, current_date, 'pwned-in', 'pwned-in');
    assert n = 0, 'LEAK: bob (member of only the INCOMING leg''s wallet) edited a transfer pair he does not fully own';
  end $$;
commit;

-- Verify from alice's side that direction 2's attempt also left BOTH
-- legs untouched.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0007') = -3000,
      'LEAK: partial-member bob''s rejected call changed the (invisible-to-him) outgoing leg''s amount';
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0008') = 3000,
      'LEAK: partial-member bob''s rejected call changed the (visible-to-him) incoming leg''s amount';
    assert (select note from transactions where id = 'a4a40000-0000-0000-0000-0000000e0008') is null,
      'LEAK: partial-member bob''s rejected call wrote a note onto the visible leg';
  end $$;
commit;

-- =====================================================================
-- Task 4 fix round 2, FIX 2: update_transfer_pair must reject an UPDATE
-- that touches something other than exactly two rows -- the guard at the
-- top of the function only catches FEWER than two (an incomplete pair);
-- nothing previously caught MORE than two. transfer_id carries no UPDATE
-- grant (0004_rls.sql/0016 grant UPDATE only on named columns), but
-- INSERT on transactions is a plain table-level grant, so a legitimate
-- member of the pair can insert a THIRD row carrying an EXISTING
-- transfer_id -- exactly what this block does, reusing the f0001 pair
-- (currently 6000/6000, per the positive-control and unbalanced-edit
-- sections above) so the "still 6000/6000 afterward" assertion is
-- checking against a known-good baseline.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, transfer_id, occurred_on) values
    ('a4a40000-0000-0000-0000-0000000e0009', 'a4a40000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer', -1, 'USD', null, 'a4a40000-0000-0000-0000-0000000f0001', current_date);

  do $$ begin
    assert (select count(*) from transactions where transfer_id = 'a4a40000-0000-0000-0000-0000000f0001') = 3,
      'test setup broken: the third leg did not land';
  end $$;

  do $$
  begin
    begin
      perform update_transfer_pair(
        'a4a40000-0000-0000-0000-0000000f0001', 6500, 6500, current_date, 'attack3', null);
      raise exception 'LEAK: update_transfer_pair updated a transfer_id with more than two rows';
    exception
      when others then
        assert sqlerrm = 'a transfer edit must update exactly two legs',
          format('wrong rejection reason: %s', sqlerrm);
    end;
  end $$;
commit;

-- Verify the more-than-two attack left every row -- both real legs AND
-- the illegitimate third row -- exactly as it found them. The illegitimate
-- row's own persistence (it was a genuine, RLS-permitted INSERT, not part
-- of the aborted UPDATE) is expected; what matters is that NOTHING was
-- rewritten by the raised call, proving the exception rolled back the
-- UPDATE rather than leaving a partial three-way write in place.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0001') = -6000,
      'LEAK: more-than-two attack changed the first leg despite being rejected';
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0002') = 6000,
      'LEAK: more-than-two attack changed the second leg despite being rejected';
    assert (select amount_minor from transactions where id = 'a4a40000-0000-0000-0000-0000000e0009') = -1,
      'LEAK: more-than-two attack changed the illegitimate third leg despite being rejected';
    assert (select note from transactions where id = 'a4a40000-0000-0000-0000-0000000e0001') = 'edited',
      'LEAK: more-than-two attack overwrote the first leg''s note despite being rejected';
  end $$;
commit;

-- =====================================================================
-- Task 7, Step 1: the transfer pair, proven against the real database.
--
-- Task 4's unit tests already assert that updateTransfer sends both
-- amounts and that both legs come back -- against a MOCKED client, which
-- returns whatever the fixture says and can therefore agree with a broken
-- statement. This block asserts the same property where the mock cannot
-- lie, and adds the one that actually matters and that no unit test can
-- see: after an edit, a same-currency pair's two legs are still EQUAL IN
-- MAGNITUDE and OPPOSITE IN SIGN, so sum(amount_minor) over the pair is
-- still exactly zero. A transfer whose legs disagree is money created or
-- destroyed, silently, with every unit test green.
--
-- It also closes a gap the Task 4 section above genuinely had: every
-- update_transfer_pair call in this file so far passes `current_date` for
-- p_occurred_on, which is the SAME date the fixtures were inserted with --
-- so a function that ignored p_occurred_on entirely, or wrote it to only
-- one leg, passed every one of them. Here the date is moved to a literal
-- that no fixture uses, and BOTH legs are checked.
--
-- A fresh pair (f0005 / e0010+e0011) in the existing Alice-only wallets
-- a001/a002: every assertion in the Task 4 sections above is keyed by row
-- id or by transfer_id, so new rows in those wallets disturb nothing, and
-- reusing f0001 would have broken the "still 6000/6000" baselines that
-- section's own attack blocks depend on.
-- =====================================================================
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$ begin
    assert (select current_user) = 'authenticated', 'impersonation failed: current_user';
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'impersonation failed: auth.uid() did not resolve to alice';
  end $$;

  -- Both legs USD (a001 and a002 are both USD wallets), so the balance
  -- invariant applies: this is the pair whose sum must stay zero.
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, transfer_id, occurred_on) values
    ('a4a40000-0000-0000-0000-0000000e0010', 'a4a40000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer', -4500, 'USD', 'a4a40000-0000-0000-0000-0000000f0005', date '2026-03-01'),
    ('a4a40000-0000-0000-0000-0000000e0011', 'a4a40000-0000-0000-0000-00000000a002', 'aaaaaaaa-0000-0000-0000-000000000001', 'transfer',  4500, 'USD', 'a4a40000-0000-0000-0000-0000000f0005', date '2026-03-01');

  do $$ begin
    assert (select sum(amount_minor) from transactions
             where transfer_id = 'a4a40000-0000-0000-0000-0000000f0005' and deleted_at is null) = 0,
      'test setup broken: the fixture pair does not start balanced';
  end $$;
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"alice@x.io"}';
  do $$
  declare
    legs int;
    out_amt bigint; in_amt bigint;
    out_on date;    in_on date;
    total bigint;   n int;
  begin
    -- The exact call src/server/actions/transactions.ts's updateTransfer
    -- makes: p_transfer_id, p_amount_out, p_amount_in, p_occurred_on,
    -- p_note, p_merchant. Amount changed (4500 -> 7300) AND date moved
    -- (2026-03-01 -> 2026-04-17) in one call, because both have to move
    -- together on both legs.
    select count(*) into legs from update_transfer_pair(
      'a4a40000-0000-0000-0000-0000000f0005', 7300, 7300, date '2026-04-17', 'pair edit', 'Ferry Co');
    assert legs = 2,
      format('PERMISSION BROKEN: member alice''s transfer edit touched %s leg(s), expected 2', legs);

    select amount_minor, occurred_on into out_amt, out_on
      from transactions where id = 'a4a40000-0000-0000-0000-0000000e0010';
    select amount_minor, occurred_on into in_amt, in_on
      from transactions where id = 'a4a40000-0000-0000-0000-0000000e0011';

    -- Signs stayed opposite, and on the SAME side each leg started on: the
    -- outgoing leg is still the negative one. update_transfer_pair takes no
    -- argument saying which leg is which -- it reads each row's own current
    -- sign -- so a CASE written backwards would flip both legs' direction
    -- while keeping the pair balanced, and this is what catches that.
    assert out_amt < 0, format('the outgoing leg lost its negative sign: %s', out_amt);
    assert in_amt  > 0, format('the incoming leg lost its positive sign: %s', in_amt);

    -- Equal in magnitude, and equal to what was asked for.
    assert out_amt = -7300, format('outgoing leg amount wrong: %s (expected -7300)', out_amt);
    assert in_amt  =  7300, format('incoming leg amount wrong: %s (expected 7300)', in_amt);
    assert abs(out_amt) = abs(in_amt),
      format('SAFETY BROKEN: the pair''s legs disagree in magnitude (%s vs %s) -- money was created or destroyed',
             out_amt, in_amt);

    -- The property no unit test can see: the pair still nets to zero.
    -- Asserted over the transfer_id, not over the two known ids, so a third
    -- leg appearing would break it too.
    select sum(amount_minor) into total from transactions
      where transfer_id = 'a4a40000-0000-0000-0000-0000000f0005' and deleted_at is null;
    assert total = 0,
      format('SAFETY BROKEN: sum(amount_minor) over the edited transfer pair is %s, not 0 -- the ledger gained or lost money', total);

    -- BOTH legs moved to the new date. Neither leg started on 2026-04-17,
    -- so a function that ignored p_occurred_on, or wrote it to only the leg
    -- the CASE happened to touch first, fails here.
    assert out_on = date '2026-04-17', format('the outgoing leg''s date did not move: %s', out_on);
    assert in_on  = date '2026-04-17', format('the incoming leg''s date did not move: %s', in_on);
    assert out_on = in_on, 'SAFETY BROKEN: the pair''s two legs are dated differently after one edit';

    -- Note and merchant likewise land on both legs, and identically -- a
    -- transfer is one movement of money described twice, so two legs
    -- describing it differently is a defect, not a preference.
    select count(*) into n from transactions
      where transfer_id = 'a4a40000-0000-0000-0000-0000000f0005'
        and deleted_at is null
        and note = 'pair edit' and merchant = 'Ferry Co';
    assert n = 2,
      format('note/merchant reached %s leg(s) of the pair, expected 2', n);

    -- Neither leg changed wallets, and neither gained a category: the
    -- transfer_shape CHECK forbids a category on a transfer, and §1.4
    -- forbids an edit moving a row between wallets. Both are enforced
    -- elsewhere, but an edit path that quietly rewrote either would be a
    -- different bug with the same symptom (a row leaving the wallet the
    -- user is looking at).
    assert (select wallet_id from transactions where id = 'a4a40000-0000-0000-0000-0000000e0010')
             = 'a4a40000-0000-0000-0000-00000000a001',
      'SAFETY BROKEN: the outgoing leg changed wallets during an edit';
    assert (select wallet_id from transactions where id = 'a4a40000-0000-0000-0000-0000000e0011')
             = 'a4a40000-0000-0000-0000-00000000a002',
      'SAFETY BROKEN: the incoming leg changed wallets during an edit';
    assert (select count(*) from transactions
             where transfer_id = 'a4a40000-0000-0000-0000-0000000f0005' and category_id is null) = 2,
      'SAFETY BROKEN: a transfer leg gained a category during an edit';
  end $$;
commit;
