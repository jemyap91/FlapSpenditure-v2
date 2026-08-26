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
-- HAZARD: `not exists` over zero rows is TRUE, so a budget with NO wallets
-- would be visible to everyone. set_budget (Task 3) refuses to create one and
-- get_budget_status (Task 2) ignores any that exists. This is the single
-- fails-open case in an otherwise fails-closed design. UNTESTED as of this
-- task: rls.sql does not yet assert the empty-set case (grep confirms no
-- such assertion exists), and the fix round that restored budget coverage
-- here did not add one either -- a later task's job, not a claim of
-- present coverage.
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
-- ACCEPTED RISK, not fixed here: this function is `not exists`, so it fails
-- OPEN, not closed, if it ever stops actually bypassing budget_wallets' RLS
-- -- if it is re-owned to a non-superuser role, or if `alter table
-- budget_wallets force row level security` is ever added (which applies RLS
-- even to the table owner). Under either degradation the inner scan would
-- see zero rows, `not exists` returns TRUE, and budget_visible silently
-- returns true for every budget -- this is C1 all over again, and it would
-- raise no error. Contrast is_wallet_member (0004), which is `exists`: the
-- identical degradation there makes it see zero rows and return FALSE --
-- fails CLOSED. That asymmetry is unavoidable here, not an oversight: the
-- empty-set HAZARD above requires `not exists`, so the fail-open direction
-- cannot be designed away without closing a hazard this task is explicitly
-- not scoped to close. Documented so the next reader relies on a fence,
-- not a guess.
create function budget_visible(b uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select not exists (
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
