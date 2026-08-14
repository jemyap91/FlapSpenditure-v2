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
  -- Named 'Custom Category', not 'Groceries': migration 0007's new-user
  -- seed trigger already fired on the auth.users insert above and gave
  -- alice 16 default categories including one named 'Groceries' ('expense'
  -- kind); reusing that name here would collide with
  -- categories_unique_active_name instead of proving RLS visibility.
  insert into categories (id, owner_id, name, kind, color_slot, icon)
    values ('dddddddd-0000-0000-0000-000000000004',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Custom Category', 'expense', 2, 'basket');
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('eeeeeeee-0000-0000-0000-000000000005',
            'cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
            'expense', -1250, 'USD', 'dddddddd-0000-0000-0000-000000000004', current_date);

  do $$ begin
    assert (select count(*) from wallets)      = 1, 'PERMISSION BROKEN: alice cannot see her own wallet';
    -- 17, not 1: migration 0007's new-user seed trigger already gave alice
    -- 16 default categories on the auth.users insert at the top of this
    -- file, plus the one she just created above.
    assert (select count(*) from categories)   = 17, 'PERMISSION BROKEN: alice cannot see her own category';
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
    -- 16, not 0: migration 0007's new-user seed trigger already gave bob
    -- his own 16 default categories on the auth.users insert at the top of
    -- this file. The probative check is that this is exactly bob's own 16
    -- (owner-scoped) and NOT 33 (his 16 plus alice's 17 from section 1) --
    -- i.e. none of alice's categories leaked into what bob can see.
    assert (select count(*) from categories)     = 16, 'LEAK: bob can see alice''s category';
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
--    wallet or its membership list. Also: wallet membership does not
--    leak the owner's private categories -- categories are owner-scoped,
--    not wallet-scoped.
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
    -- Negative (extra attack, not named in the brief): membership does
    -- NOT leak alice's categories -- categories are owner-scoped. 16, not
    -- 0: migration 0007's seed trigger already gave bob his own 16
    -- default categories; the probative check is that this is exactly
    -- bob's own 16 and not 33 (his 16 plus alice's 17: her 16 seeded plus
    -- the one she created in section 1).
    assert (select count(*) from categories) = 16,
      'LEAK: wallet membership exposed alice''s private categories';
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
  insert into categories (id, owner_id, name, kind, color_slot, icon)
    values ('a4a4a4a4-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Dining', 'expense', 7, 'utensils');

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

  insert into categories (id, owner_id, name, kind, color_slot, icon)
    values ('a4a4a4a4-0000-0000-0000-000000000002',
            'bbbbbbbb-0000-0000-0000-000000000002', 'Bob Category', 'expense', 1, 'shopping-cart');
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
