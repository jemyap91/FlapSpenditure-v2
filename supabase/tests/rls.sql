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
  insert into categories (id, owner_id, name, kind, color_slot, icon)
    values ('dddddddd-0000-0000-0000-000000000004',
            'aaaaaaaa-0000-0000-0000-000000000001', 'Groceries', 'expense', 2, 'basket');
  insert into transactions (id, wallet_id, created_by, kind, amount_minor, currency_code, category_id, occurred_on)
    values ('eeeeeeee-0000-0000-0000-000000000005',
            'cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
            'expense', -1250, 'USD', 'dddddddd-0000-0000-0000-000000000004', current_date);

  do $$ begin
    assert (select count(*) from wallets)      = 1, 'PERMISSION BROKEN: alice cannot see her own wallet';
    assert (select count(*) from categories)   = 1, 'PERMISSION BROKEN: alice cannot see her own category';
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
-- The wallet created for the transfer's destination deliberately does
-- NOT reuse 'eeeeeeee-0000-0000-0000-000000000005' (the id the plan's
-- snippet used) -- that id already names Alice's transaction row created
-- in section 1 above. Different tables, so no key collision, but reusing
-- it here would be a readability trap; '77777777-...-007' is used
-- instead.
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

-- Attack: create_transfer must reject a transfer to the same wallet on
-- both sides, even for a caller who is a legitimate member of it.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select auth.uid()) = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'impersonation failed';
  end $$;

  do $$
  declare before_count int; after_count int;
  begin
    select count(*) into before_count from transactions;
    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               'cccccccc-0000-0000-0000-000000000003',
                               1000, 1000, current_date, null);
      raise exception 'LEAK: create_transfer allowed a same-wallet transfer';
    exception
      when others then
        assert sqlerrm = 'cannot transfer to the same wallet',
          format('wrong rejection reason: %s', sqlerrm);
    end;
    select count(*) into after_count from transactions;
    assert before_count = after_count, 'a rejected same-wallet transfer must leave no trace';
  end $$;
commit;

-- Attack: create_transfer must reject a caller who is not a member of
-- either wallet. Bob has no membership anywhere in the file yet.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  do $$ begin
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
  end $$;

  do $$
  declare before_count int; after_count int;
  begin
    select count(*) into before_count from transactions;
    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               1000, 1000, current_date, null);
      raise exception 'LEAK: create_transfer allowed a transfer by a non-member of either wallet';
    exception
      when others then
        assert sqlerrm = 'not a member of both wallets',
          format('wrong rejection reason: %s', sqlerrm);
    end;
    select count(*) into after_count from transactions;
    assert before_count = after_count, 'a rejected transfer must leave no trace';
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
    assert (select count(*) from categories)     = 0, 'LEAK: bob can see alice''s category';
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

-- Verify from Alice's side that the attack left no trace (still exactly 3
-- rows: her original expense plus the two transfer legs created in the
-- Task 9 block above).
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  do $$ begin
    assert (select count(*) from transactions) = 3,
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
    assert (select auth.uid()) = 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'impersonation failed';
    assert is_wallet_member('cccccccc-0000-0000-0000-000000000003'::uuid) = true,
      'test setup broken: bob should be a member of cccccccc-003 by now';
    assert is_wallet_member('77777777-0000-0000-0000-000000000007'::uuid) = false,
      'test setup broken: bob should not be a member of 77777777-007';
  end $$;

  do $$
  declare before_count int; after_count int;
  begin
    select count(*) into before_count from transactions;
    begin
      perform create_transfer('cccccccc-0000-0000-0000-000000000003',
                               '77777777-0000-0000-0000-000000000007',
                               1000, 1000, current_date, null);
      raise exception 'LEAK: create_transfer allowed a transfer by a member of only one wallet';
    exception
      when others then
        assert sqlerrm = 'not a member of both wallets',
          format('wrong rejection reason: %s', sqlerrm);
    end;
    select count(*) into after_count from transactions;
    assert before_count = after_count, 'a rejected transfer must leave no trace';
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
    -- NOT leak alice's categories -- categories are owner-scoped.
    assert (select count(*) from categories) = 0,
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
