-- supabase/migrations/0013_wallet_set_budgets.sql

-- 0012 keyed a budget to exactly one wallet. A budget now carries a SET of
-- wallets (spec 2026-08-25). 0012 was never applied to the hosted database,
-- so this drops and recreates instead of migrating data.
--
-- CORRECTION to this migration's original plan: `cascade` on a DROP TABLE
-- does NOT reach get_budget_status or set_budget, even though both query
-- budgets in their body. Postgres's dependency tracking for a PL/pgSQL
-- function only covers its signature (parameter/return types) -- the SQL
-- text inside the body is opaque to it, so a table referenced only via
-- `from public.budgets` inside the function is invisible to CASCADE.
-- Verified empirically: after `drop table budgets cascade` alone, both
-- functions were still present in pg_proc and, when called, failed at
-- runtime with "column b.wallet_id does not exist" / "column \"wallet_id\"
-- of relation \"budgets\" does not exist" -- silently broken rather than
-- gone. Both are dropped explicitly below so Task 2 and Task 3 recreate
-- them against a clean slate instead of colliding with (or masking) a
-- stale, now-incompatible definition.
drop table if exists budgets cascade;
drop function if exists get_budget_status(date, date);
drop function if exists set_budget(uuid, uuid, date, bigint);

create table budgets (
  id            uuid primary key default gen_random_uuid(),
  -- Provenance, NOT permission: who can see this budget is decided entirely
  -- by its wallet set (budgets_visible below), never by created_by.
  created_by    uuid not null references auth.users(id),
  -- Denormalised from the set's wallets, which must all share it. Stored so a
  -- budget is self-describing and so a primary-currency shift is visible
  -- rather than silently matching nothing. Referenced, matching every other
  -- currency_code column in this schema (wallets, transactions): without the
  -- FK a budget could carry a currency no wallet ever could.
  currency_code char(3) not null references currencies(code),
  -- lower(btrim(name)) of the category, or NULL for this set's overall cap.
  -- A NAME, not an id, because categories are wallet-scoped since 0008 and a
  -- budget spanning wallets has no single category row to reference. The
  -- CHECK enforces the format this comment promises -- normalised, non-empty
  -- when present -- so the next task's join against categories.name cannot
  -- miss a row over 'Groceries' vs 'groceries ' vs ''. A CHECK is satisfied
  -- by NULL, so the overall cap (category_key is null) is unaffected.
  category_key  text check (category_key = lower(btrim(category_key)) and category_key <> ''),
  period_start  date not null check (extract(day from period_start) = 1),
  amount_minor  bigint not null check (amount_minor > 0),
  created_at    timestamptz not null default now()
);

create table budget_wallets (
  budget_id uuid not null references budgets(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  primary key (budget_id, wallet_id)
);

create index budget_wallets_wallet on budget_wallets (wallet_id);

alter table budgets enable row level security;
alter table budget_wallets enable row level security;

-- A budget is visible to exactly those who can see ALL the money it covers.
-- One rule, no flag: a set of one shared wallet stays shared with that
-- wallet's members (0012's behaviour); a set spanning personal wallets is
-- personal. A budget covering a wallet you are not in is unrepresentable, so
-- it cannot surface figures derived from spending you cannot see.
--
-- HAZARD (CLOSED, in this function): `not exists` over zero rows is TRUE,
-- so a membership-only predicate would return TRUE for a budget with NO
-- budget_wallets rows -- visible to everyone. This is not a paper case:
-- budget_wallets.wallet_id is ON DELETE CASCADE and any wallet owner can
-- delete her own wallet at will, so a wallet owner deleting a wallet
-- silently empties the SET of every budget that named it -- including
-- budgets she does not own, over sets shared with other members who were
-- never asked. Before this fix, that left BOTH the table's own RLS policy
-- (budgets_visible, below, whose predicate IS budget_visible(id)) and
-- get_budget_status (Task 2) exposed: a wallet-less budget's created_by
-- (another user's id), category_key (a category NAME -- e.g. "therapy"),
-- and amount_minor were all readable -- and, until Task 2 additionally
-- revoked INSERT below, writable/deletable -- by ANY authenticated user
-- through PostgREST. get_budget_status hiding the same row from its own
-- output did NOT close this: the aggregate is not the only reader of this
-- table, and the underlying row stayed exposed at the RLS layer the whole
-- time.
--
-- FIX: the non-empty test lives HERE, in budget_visible itself (the first
-- conjunct below), not duplicated in get_budget_status's own query -- one
-- auditable definition, used by both budgets_visible (the table policy)
-- and get_budget_status (which calls this same function in its `vis` CTE),
-- so the two cannot silently drift apart on this question again.
-- get_budget_status's own CTEs (`keyed`, `spend`, `scope`) each ALSO INNER
-- JOIN budget_wallets independently of `vis`, which gives that function's
-- output three-fold redundant protection beneath budget_visible -- not
-- singly redundant, as an earlier draft of this comment (and of the
-- get_budget_status test section) claimed; confirmed by removing only the
-- exists() clause that used to live in `vis` and observing the wallet-less
-- budget still did not surface (see task-2-report.md). That redundancy is
-- incidental to those CTEs' join shape, not a designed second line of
-- defense, and none of it reaches the `budgets` table itself: budget_visible
-- is the only thing that does, which is why the non-empty test belongs here,
-- not only in the aggregate.
--
-- CONSEQUENCE, accepted and deliberate: a budget that loses its entire
-- wallet set (via this cascade, or any other means) becomes invisible to
-- EVERYONE, including the user who created it -- budget_visible cannot
-- distinguish "never had wallets" from "had wallets, all since deleted",
-- and there is no "recover my orphaned budget" path this schema supports.
-- That is intentional: silently disappearing is a strictly better failure
-- mode than the world-readable one it replaces, and it costs only the
-- budget's own creator (who can create a replacement), not every other
-- member of the wallets involved. Tested in rls.sql: the "Budgets (0013):
-- get_budget_status" section's empty-set block asserts absence from
-- get_budget_status AND, in the table-layer block right after it, absence
-- from a direct SELECT against `budgets` -- for both a stranger and the
-- budget's own creator.
--
-- SECURITY DEFINER wrapper is REQUIRED, not stylistic, and for the exact
-- reason 0004_rls.sql's opening comment gives for is_wallet_member: Postgres
-- applies a REFERENCED table's own RLS policies when evaluating a query
-- inside another table's policy expression. budget_wallets carries its own
-- RLS (budget_wallets_member, below) filtering to is_wallet_member(wallet_id)
-- -- so a plain `select 1 from budget_wallets bw where ...` run inside this
-- policy would only ever see rows the caller already has access to. Against
-- that filtered view, `not is_wallet_member(bw.wallet_id)` is false for
-- every row Postgres lets the subquery see, so the subquery always returns
-- zero rows and `not exists` is always TRUE -- budgets_visible degenerates
-- to `true` for every user and every budget, unlike wallet_members and
-- is_wallet_member, this doesn't recurse into "infinite recursion detected
-- in policy" (budget_wallets_member does not reference budgets), so it fails
-- SILENTLY OPEN instead of raising. A `security definer` function run with
-- `set search_path = ''` bypasses RLS entirely (the same property
-- is_wallet_member relies on), so the inner select sees every
-- budget_wallets row regardless of the caller's membership, and the
-- fails-closed intent below is what actually executes.
--
-- ACCEPTED RISK, narrowed by this fix but NOT eliminated: the EVERY-wallet
-- half of this predicate (the second conjunct below) is still `not
-- exists`, so it still fails OPEN for a caller who is a member of AT LEAST
-- ONE wallet in a multi-wallet set, if this function ever stops actually
-- bypassing budget_wallets' RLS (re-owned to a non-superuser role, or
-- `alter table budget_wallets force row level security`). Under that
-- degradation the inner scan of the second conjunct would see only the
-- rows the caller's OWN membership already lets her see -- all of which
-- trivially satisfy is_wallet_member -- so `not exists` still returns TRUE
-- for her: this is C1 all over again, for a PARTIAL member, and it would
-- raise no error. The first conjunct (added by this fix) DOES fail closed
-- under the same degradation for a caller who is a member of NONE of the
-- set's wallets: degraded RLS would show her zero budget_wallets rows for
-- this budget_id, `exists` returns FALSE, and the whole function returns
-- FALSE. So this fix narrows the fails-open surface from "any
-- authenticated caller" to "a caller who shares at least one wallet with
-- the set" -- it does not close it. Contrast is_wallet_member (0004),
-- which is a single `exists`: the identical degradation there fails
-- CLOSED unconditionally. Documented so the next reader relies on a
-- fence, not a guess.
create function budget_visible(b uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.budget_wallets bw where bw.budget_id = b)
     and not exists (
       select 1 from public.budget_wallets bw
       where bw.budget_id = b and not public.is_wallet_member(bw.wallet_id)
     )
$$;
revoke all on function budget_visible(uuid) from public, anon;
grant execute on function budget_visible(uuid) to authenticated;

create policy budgets_visible on budgets for all to authenticated
  using (budget_visible(id)) with check (budget_visible(id));

-- Gated on the wallet named in the row, so the join table cannot be read to
-- enumerate wallet ids belonging to other people.
create policy budget_wallets_member on budget_wallets for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));

-- 0004's own comment: the default ACL gives `authenticated` no DML, so a
-- policy without a grant is dead code.
grant select, insert, delete on budgets to authenticated;
-- Column-restricted UPDATE, matching transactions_member and the fix made to
-- 0012: `using` sees the old row and `with check` the new one, both asking the
-- same question, so an unrestricted grant would let a member re-point a budget
-- by changing a column the policy cannot distinguish.
grant update (amount_minor) on budgets to authenticated;

-- C1 fix round (Task 2): INSERT is revoked again immediately. Before this,
-- an authenticated caller could INSERT a budget of her own choosing with NO
-- budget_wallets row yet -- budgets_visible's WITH CHECK, at that instant,
-- asked budget_visible() a question about a budget that still had zero
-- rows in budget_wallets, which (pre-fix) answered TRUE regardless of who
-- was asking. That is not a narrow window: nothing stops the caller from
-- simply never attaching a wallet afterward (she has no INSERT grant on
-- budget_wallets to do so anyway -- see I2 below), landing exactly the
-- world-readable row the HAZARD comment above describes, on purpose, at
-- will. Composition is already function-mediated for budget_wallets;
-- budgets now matches. set_budget (Task 3, SECURITY DEFINER) becomes the
-- sole creator, re-checking the WHOLE submitted wallet set -- including
-- that it is non-empty -- before writing, which per-row table RLS
-- structurally cannot do (the same reasoning the budget_wallets grant
-- comment below already gives for why INSERT/DELETE are withheld there).
--
-- LANDMINE FOR TASK 3, spelled out here because it is not obvious from
-- reading set_budget's own future file in isolation: folding the
-- non-empty test into budget_visible (above) makes
-- `with check (budget_visible(id))` UNSATISFIABLE for every INSERT, not
-- merely tightened. At the instant a row is inserted it has zero
-- budget_wallets children by construction -- they cannot exist yet, since
-- budget_wallets.budget_id is a foreign key into a budgets row that must
-- already exist -- so budget_visible's first conjunct
-- (`exists (select 1 from budget_wallets bw where bw.budget_id = b)`) is
-- FALSE for every candidate row, no matter who is inserting or what the
-- row contains. budgets_visible's WITH CHECK is therefore dead code for
-- INSERT specifically (it stays live for `update (amount_minor)`, whose
-- row already has children by the time it runs) and budget creation
-- survives ONLY through set_budget running as an OWNER-RIGHTS SECURITY
-- DEFINER function that re-checks membership over the submitted wallet
-- set itself, inserts the budget row, and inserts its budget_wallets rows
-- in the same transaction, bypassing budgets_visible entirely by design.
-- Do NOT follow 0012_budgets.sql's set_budget as precedent here: that
-- function was deliberately `security invoker`, with its own comment
-- arguing RLS should decide the write -- correct for 0012's shape, where
-- a budget referenced at most one wallet_id column, not one for this
-- shape, where WITH CHECK cannot pass at insert time under ANY caller.
-- An invoker set_budget written against this schema would have every
-- budget INSERT rejected by budgets_visible, unconditionally, and the
-- failure would look identical to a permissions bug rather than the
-- structural impossibility it actually is.
revoke insert on budgets from authenticated;

-- SELECT only. INSERT and DELETE are deliberately NOT granted here, even
-- though budget_wallets_member's own RLS predicate (is_wallet_member) would
-- otherwise allow a member to write a row: foreign key checks bypass RLS
-- entirely, so a row like (X, <a wallet I'm in>) can legally reference a
-- budget X the inserting user cannot see one column of and does not fully
-- control the wallet SET of. A member of exactly one of budget X's wallets
-- could otherwise unilaterally add a second, unrelated wallet of her own to
-- X's set (making X span a wallet its other members never agreed to), or
-- delete X's only row naming a wallet another member is in (silently
-- emptying the set toward the fails-open HAZARD above, permanently, for
-- everyone). set_budget (Task 3) becomes the sole path that composes or
-- changes a budget's wallet set: it runs SECURITY DEFINER and re-checks
-- membership over the WHOLE submitted set before writing, which per-row
-- table RLS structurally cannot do. No UPDATE grant either, and none is
-- needed: every column of budget_wallets is part of its primary key, so an
-- UPDATE here is a re-point, not an edit -- the same shape a missing grant
-- silently forecloses elsewhere in this schema without needing its own
-- sentence (0004 spells this out for transactions.wallet_id; this comment
-- is that sentence for budget_wallets).
grant select on budget_wallets to authenticated;

-- One row per visible budget, plus one row per category with spending that no
-- visible budget covers. Self-scoping: no wallet-ids parameter, so there is no
-- caller-supplied filter to tamper with.
create function get_budget_status(from_date date, to_date date)
  returns table (
    budget_id uuid, category_key text, category_label text,
    currency_code char(3), wallet_names text[], wallet_count int,
    spent_minor bigint, budget_minor bigint, budget_period_start date
  )
  language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  with mine as (
    select w.id, w.name, w.currency_code
    from public.wallets w
    where public.is_wallet_member(w.id) and w.archived_at is null
  ),
  -- Delegates entirely to budget_visible(id): membership AND the
  -- non-empty (wallet-less) test both live there now, folded into one
  -- definition -- see 0013's HAZARD comment above budget_visible's
  -- definition for why that fold matters beyond this function: budgets'
  -- own RLS policy calls the same function, so a wallet-less budget that
  -- this function alone hid would still have been exposed at the table
  -- layer. `keyed`, `spend`, and `scope` below each ALSO INNER JOIN
  -- budget_wallets independently of `vis`, which makes this function's
  -- own exclusion of a wallet-less budget three-fold redundant beneath
  -- budget_visible -- incidental to those CTEs' join shape, not a second
  -- deliberate line of defense, and not a reason to weaken budget_visible
  -- itself.
  vis as (
    select b.* from public.budgets b where public.budget_visible(b.id)
  ),
  -- Canonical identity for a wallet SET, so carry-forward can ask "the most
  -- recent budget for THIS set and category" without a set-valued join key.
  keyed as (
    select v.id, v.category_key, v.period_start, v.amount_minor, v.currency_code,
           string_agg(bw.wallet_id::text, ',' order by bw.wallet_id) as set_key
    from vis v
    join public.budget_wallets bw on bw.budget_id = v.id
    where v.period_start <= from_date
    group by v.id, v.category_key, v.period_start, v.amount_minor, v.currency_code
  ),
  -- Carry-forward: the most recent row at or before the month, per set and
  -- category. A budget set in September governs October until another exists.
  eff as (
    select distinct on (k.set_key, k.category_key) k.*
    from keyed k
    order by k.set_key, k.category_key, k.period_start desc
  ),
  -- Every predicate lives in the ON clause, none in a WHERE. Filtering the
  -- right-hand side of a LEFT JOIN in WHERE would discard the whole budget
  -- when nothing matches (a NULL comparison is not true), so a budget with no
  -- spending yet would VANISH instead of reporting 0 -- the disappearing-row
  -- dead end this redesign exists to remove. `coalesce` then turns the
  -- no-match case into a genuine zero.
  -- Joins `mine`, not just `budget_wallets`, for the same restriction
  -- `scope` already applies (membership AND not-archived): without it, a
  -- set spanning one active and one archived wallet would sum spending
  -- from BOTH here while `scope` (and its wallet_names/wallet_count) lists
  -- only the active one -- a spent_minor nobody could reconcile against
  -- the wallets shown for it.
  spend as (
    select e.id as budget_id, coalesce(sum(-t.amount_minor), 0)::bigint as spent
    from eff e
    join public.budget_wallets bw on bw.budget_id = e.id
    join mine m on m.id = bw.wallet_id
    left join public.transactions t
      on t.wallet_id = bw.wallet_id
     and t.kind = 'expense'
     and t.deleted_at is null
     and t.occurred_on between from_date and to_date
    left join public.categories c
      on c.id = t.category_id
     and (e.category_key is null or lower(btrim(c.name)) = e.category_key)
    -- Drop transactions that matched a wallet but not this budget's category,
    -- without dropping budgets that matched nothing at all.
    where t.id is null or c.id is not null or e.category_key is null
    group by e.id
  ),
  scope as (
    select bw.budget_id, array_agg(m.name order by m.name) as names, count(*)::int as n
    from public.budget_wallets bw join mine m on m.id = bw.wallet_id
    group by bw.budget_id
  ),
  -- Spending in my wallets whose category no visible budget covers FOR
  -- THAT WALLET. Correlated to t.wallet_id via budget_wallets, not just to
  -- the category key: an uncorrelated `not exists (select 1 from eff e
  -- where e.category_key = ...)` would treat "Groceries is budgeted
  -- somewhere" as covering every wallet's Groceries spending, including a
  -- wallet the budget's set never named -- so spending on a budgeted
  -- category, in a wallet the budget does NOT cover, would be excluded
  -- from `spend` (wrong wallet) AND from `uncovered` (category exists in
  -- `eff`) and vanish from the report entirely. That is exactly the
  -- scenario this redesign exists to support (a category budgeted for a
  -- SUBSET of wallets), so it must not be the one case spending goes
  -- unreported.
  uncovered as (
    select lower(btrim(c.name)) as key, min(c.name) as label,
           m.currency_code, sum(-t.amount_minor)::bigint as spent
    from public.transactions t
    join mine m on m.id = t.wallet_id
    join public.categories c on c.id = t.category_id
    where t.kind = 'expense' and t.deleted_at is null
      and t.occurred_on between from_date and to_date
      and not exists (
        select 1 from eff e
        join public.budget_wallets bw on bw.budget_id = e.id
        where bw.wallet_id = t.wallet_id
          and e.category_key = lower(btrim(c.name))
      )
    group by 1, 3
  )
  select e.id, e.category_key,
         coalesce((select min(c.name) from public.categories c
                   where lower(btrim(c.name)) = e.category_key), e.category_key),
         e.currency_code, s.names, s.n,
         sp.spent, e.amount_minor, e.period_start
  from eff e
  join spend sp on sp.budget_id = e.id
  join scope s on s.budget_id = e.id
  union all
  select null::uuid, u.key, u.label, u.currency_code, null::text[], null::int,
         u.spent, null::bigint, null::date
  from uncovered u;
end $$;

revoke all on function get_budget_status(date, date) from public, anon;
grant execute on function get_budget_status(date, date) to authenticated;

-- Creating or updating a budget is multi-row (a budgets row plus one
-- budget_wallets row per wallet) and carries invariants a client cannot be
-- trusted with, so it lives here, as the brief for this task already argued.
--
-- SECURITY DEFINER, NOT `security invoker` as an earlier draft of this
-- function (and 0012_budgets.sql's own set_budget, for the single-wallet
-- shape that preceded this one) had it. That precedent does not carry over:
-- folding the non-empty-set test into budget_visible (above) makes
-- `budgets_visible`'s WITH CHECK (`budget_visible(id)`) unsatisfiable for
-- EVERY insert, no matter who runs it or what the row contains -- at the
-- instant a budgets row is inserted it has zero budget_wallets children by
-- construction (they FK to a budget_id that must already exist), so
-- budget_visible's first conjunct is false unconditionally. There is no
-- ordering of the two inserts that fixes this: the child cannot precede the
-- parent. `authenticated` also holds no INSERT on budgets and no INSERT or
-- DELETE on budget_wallets any more (both revoked earlier in this file) --
-- an invoker-rights function would have neither the privilege nor a
-- satisfiable policy to create anything. This function therefore runs with
-- OWNER RIGHTS, bypasses RLS entirely on both tables, and is now the ONLY
-- path by which a budget can be created or its wallet set composed.
--
-- Because it is DEFINER, its own guards below are the WHOLE security
-- boundary, not a friendlier error message in front of one RLS already
-- provides (contrast create_transfer, 0005, which is genuinely invoker and
-- says so). RLS will not catch a caller submitting a wallet she does not
-- belong to; nothing else will either. Every guard is therefore an explicit,
-- verified check, not a courtesy.
--
-- search_path = '' for the same pg_temp-hijack reason 0004's is_wallet_member
-- gives, and more sharply here: this function writes, as the table owner, to
-- two tables a caller has no direct grant to touch. Every RELATION reference
-- below is schema-qualified (public.wallets, public.budgets,
-- public.budget_wallets, public.is_wallet_member, auth.uid()) -- that is
-- what an empty search_path actually defends: a caller-created pg_temp
-- table or view shadowing an unqualified name. REVIEW FINDING (M1): an
-- earlier draft of this comment claimed "every name" was qualified, which
-- was not true of the plain function/operator calls in the body (unnest,
-- string_agg, count, cardinality) -- left unqualified deliberately, matching
-- this file's other functions (get_budget_status, is_wallet_member), because
-- pg_temp is not searched for functions or operators, only relations, so
-- there is nothing for those particular names to hijack.
create function set_budget(
  p_category_key text, p_period_start date, p_amount_minor bigint, p_wallet_ids uuid[]
) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare
  v_currency char(3);
  v_count int;
  v_existing uuid;
  v_key text;
  v_id uuid;
begin
  if p_period_start is null or p_amount_minor is null or p_wallet_ids is null then
    raise exception 'period, amount and accounts must not be null';
  end if;
  if p_amount_minor <= 0 then
    raise exception 'budget amount must be positive';
  end if;

  -- REVIEW FINDING (I3): normalise BEFORE the read-modify-write lookup
  -- below uses p_category_key (and before the INSERT), so two calls
  -- differing only in case or surrounding whitespace match the same
  -- canonical budget instead of silently creating two. Without this, every
  -- caller of the only entry point into this table would have to
  -- pre-normalise client-side, and a non-normalised value would surface as
  -- a raw budgets_category_key_check violation -- exactly the "rely on a
  -- constraint to catch what a guard should" pattern this task's addendum
  -- warned against. nullif(..., '') keeps the NULL meaning ("this set's
  -- overall cap") intact rather than turning it into the empty string.
  p_category_key := nullif(lower(btrim(p_category_key)), '');

  -- REVIEW FINDING (I3): likewise for period_start -- budgets_period_start_check
  -- exists to catch a bug that reaches the table directly (e.g. a future
  -- migration or an admin script), not to be the caller-facing error for
  -- the one function that is supposed to have already checked this.
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'a budget period must start on the first of a month';
  end if;

  -- The fails-open case: a budget with no wallets satisfies budget_visible's
  -- non-empty test for NO ONE (it now fails closed -- see 0013's HAZARD
  -- comment above budget_visible), so a wallet-less budget this function
  -- created would be invisible to its own creator forever, with no path to
  -- recover it. Refused here rather than left to rot silently.
  --
  -- cardinality(), NOT array_length(p_wallet_ids, 1) as an
  -- earlier draft had it -- REVIEW FINDING (C1, CRITICAL), left here so the
  -- next reader does not reintroduce it: array_length(x, 1) measures only
  -- the array's FIRST DIMENSION. For a doubly-nested literal like
  -- '{{w1,w2}}'::uuid[] (one row of two columns, not two rows), PostgREST
  -- accepts this over HTTP from an ordinary JSON array-of-arrays, a raw
  -- '{{...}}' literal, or Prefer: params=single-object -- all three were
  -- proven to reach this function with a real authenticated JWT.
  -- array_length(..., 1) = 1 for that value while `= any(...)` and
  -- unnest(...) below both traverse EVERY element regardless of
  -- dimensionality, so the membership guard immediately below silently
  -- checked membership against only ONE wallet while writing budget_wallets
  -- rows, and computing v_key, over TWO -- letting a caller who is a member
  -- of exactly one of two wallets plant (or, worse, silently UPDATE, since
  -- v_key derived from unnest() collides with the flat form's key) a budget
  -- over a wallet she has no relationship to. cardinality() counts every
  -- element regardless of dimensionality and returns 0 (not NULL) for an
  -- empty array, which is why the non-empty test below reads `= 0` rather
  -- than `is null`. See supabase/tests/rls.sql's "C1" block for the nested
  -- payload regression test that watches this fail without the fix.
  if cardinality(p_wallet_ids) = 0 then
    raise exception 'a budget must cover at least one account';
  end if;

  -- EVERY wallet in the set, not any: budget_visible's second conjunct
  -- (documented above as fails-open under RLS degradation) is exactly the
  -- property this guard exists to enforce unconditionally, since this
  -- function does not rely on that RLS conjunct at all -- it runs before
  -- RLS is ever consulted. A caller who shares only some of the submitted
  -- wallets must not be able to plant a budget over the rest.
  --
  -- Also the guard that keeps v_key (below) canonical: `= any(p_wallet_ids)`
  -- matches each DISTINCT wallet id in wallets at most once, so a caller
  -- who submits the same wallet id twice (e.g. [w1, w1]) gets v_count = 1
  -- against cardinality() = 2 and is refused here too -- with a misleading
  -- message ("not a member of every account"), since the real problem is a
  -- duplicate, not a stranger's wallet (see M4 in task-3-report.md). Left
  -- deliberately unfixed for message accuracy: deduping here would let a
  -- submitted duplicate silently produce a non-canonical v_key downstream,
  -- and this count check is the ONLY thing preventing that, not merely the
  -- membership check it reads as.
  select count(*) into v_count from public.wallets w
   where w.id = any(p_wallet_ids) and public.is_wallet_member(w.id);
  if v_count <> cardinality(p_wallet_ids) then
    raise exception 'not a member of every account in that set';
  end if;

  -- REVIEW FINDING (M5): without this, a budget over an archived wallet was
  -- created successfully and then never appeared in get_budget_status,
  -- whose `scope` CTE inner-joins `mine` (is_wallet_member AND
  -- archived_at is null) -- a silently orphaned budget, not a rejected one.
  -- Deliberately placed AFTER the membership guard above, not before: at
  -- this point every id in p_wallet_ids has already been proven to name a
  -- wallet the caller is a genuine member of, so this query cannot be used
  -- to probe the archived status of a wallet belonging to someone else --
  -- it only ever answers the question for wallets already established as
  -- the caller's own.
  if exists (
    select 1 from public.wallets w
    where w.id = any(p_wallet_ids) and w.archived_at is not null
  ) then
    raise exception 'an archived account cannot be part of a budget';
  end if;

  select count(distinct w.currency_code) into v_count from public.wallets w
   where w.id = any(p_wallet_ids);
  if v_count <> 1 then
    raise exception 'every account in a budget must use the same currency';
  end if;
  select distinct w.currency_code into v_currency from public.wallets w
   where w.id = any(p_wallet_ids);

  v_key := (select string_agg(x::text, ',' order by x) from unnest(p_wallet_ids) x);

  -- Uniqueness lives here rather than in an index: a wallet SET cannot be a
  -- unique index key without a trigger-maintained canonical column, and this
  -- schema deliberately has no ON CONFLICT target for that reason -- do not
  -- add one. A duplicate is no longer catastrophic (overlapping budgets over
  -- DIFFERENT sets are a supported feature, so it would render as two
  -- identical rows rather than a corrupted figure) but calling this function
  -- twice for the SAME set, category and month must still read as an EDIT,
  -- not a second budget, so read-modify-write against the canonical set_key
  -- below.
  select b.id into v_existing
    from public.budgets b
   where b.period_start = p_period_start
     and b.category_key is not distinct from p_category_key
     and (select string_agg(bw.wallet_id::text, ',' order by bw.wallet_id)
            from public.budget_wallets bw where bw.budget_id = b.id) = v_key
   limit 1;

  if v_existing is not null then
    -- Safe to update unconditionally: v_existing was found by matching
    -- v_key, the canonical form of p_wallet_ids, so v_existing's wallet set
    -- IS p_wallet_ids -- the exact set membership was just verified over,
    -- above. This claim depends entirely on v_key actually being canonical
    -- -- REVIEW FINDING (C1, CRITICAL): an earlier draft of this comment
    -- claimed this branch was UNREACHABLE with an unverified set, which was
    -- false while v_key was computed via unnest() (which traverses every
    -- element of a nested array) but the guard above measured membership
    -- via array_length(..., 1) (which does not). Under that mismatch, a
    -- caller who was a genuine member of only ONE of two wallets could
    -- reach this exact branch by submitting them nested, and UPDATE
    -- amount_minor on a budget over a wallet set she did not fully belong
    -- to -- proven reachable end-to-end over PostgREST, not merely
    -- theoretical. Now that both the guard and v_key agree on
    -- cardinality/unnest (every element, regardless of dimensionality),
    -- the claim above holds for real: there is no way to reach this branch
    -- with a set the caller is not a full member of.
    update public.budgets set amount_minor = p_amount_minor where id = v_existing;
    return v_existing;
  end if;

  -- created_by = auth.uid(), the CALLER -- not a parameter, so there is
  -- nothing here for a caller to forge. SECURITY DEFINER changes the
  -- executing ROLE for privilege checks, not the JWT session claims:
  -- auth.uid() still reads request.jwt.claims from the calling session, so
  -- this identifies the person who invoked the RPC, exactly as it would
  -- under security invoker. Verified in supabase/tests/rls.sql, not merely
  -- asserted here.
  insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
  values (auth.uid(), v_currency, p_category_key, p_period_start, p_amount_minor)
  returning id into v_id;

  insert into public.budget_wallets (budget_id, wallet_id)
  select v_id, x from unnest(p_wallet_ids) x;

  return v_id;
end $$;

revoke all on function set_budget(text, date, bigint, uuid[]) from public, anon;
grant execute on function set_budget(text, date, bigint, uuid[]) to authenticated;
