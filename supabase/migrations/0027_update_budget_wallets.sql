-- 0027: editing a budget's wallet set.
--
-- A budget's wallet set is its identity: set_budget (0013, reshaped in
-- 0023) matches an existing row on (period_start, category_id, exact
-- wallet-id set) and get_budget_status carries a row forward keyed on the
-- same set. So there has been no way to CHANGE a set -- resubmitting a
-- budget with more wallets through set_budget creates a second,
-- overlapping budget and leaves the first alive. That matters most for the
-- case 0013's design accepted and asked the UI to disclose: "all wallets"
-- is materialised at creation, so a wallet created afterward is never
-- covered, and the only recourse was remove-and-recreate.
--
-- This function replaces one budget's budget_wallets rows in place. The
-- budget keeps its id, month, category, amount and currency. Chosen over
-- versioning the change by month (a new row from this month, the old one
-- ended): the wallet set IS the carry-forward key, so a set change
-- re-identifies the series rather than amending a value within it, and an
-- "ended" concept would have to be threaded through get_budget_status's
-- `eff`. The accepted cost, which the UI states: a budget set in an
-- earlier month reports that month over the NEW set too.
--
-- SECURITY DEFINER for the same reason set_budget is: INSERT and DELETE on
-- budget_wallets are not granted to authenticated (0013's C1 fix round --
-- a member could otherwise re-point a budget row by row), so this is the
-- only path that can rewrite a set, and it re-checks everything itself.
-- Every guard is set_budget's own, kept in the same order for the same
-- reasons (membership BEFORE archived/currency, so neither can probe
-- another household's wallets), with two changes:
--   * the set must match the BUDGET's stored currency_code, not merely
--     agree with itself -- the amount is denominated in it (0013
--     denormalised the column for exactly this); a lone EUR wallet under an
--     SGD amount is meaningless, not merely unusual;
--   * the budget itself must pass budget_visible(): a caller who cannot see
--     a budget (not a member of every wallet it covers today) gets the same
--     message a nonexistent id gets, and learns nothing.
-- The household guard set_budget carries is not repeated: the rows are
-- inserted with the budget's own space_id, and budget_wallets_wallet_same_
-- space (0023) refuses a wallet from any other household.
create function update_budget_wallets(p_budget_id uuid, p_wallet_ids uuid[])
  returns uuid
  language plpgsql security definer set search_path = '' as $$
declare
  v_budget   public.budgets%rowtype;
  v_count    int;
  v_key      text;
  v_clash    uuid;
begin
  if p_budget_id is null or p_wallet_ids is null then
    raise exception 'budget and accounts must not be null';
  end if;

  select b.* into v_budget from public.budgets b
   where b.id = p_budget_id and public.budget_visible(b.id);
  if v_budget.id is null then
    raise exception 'that budget does not exist';
  end if;

  if cardinality(p_wallet_ids) = 0 then
    raise exception 'a budget must cover at least one account';
  end if;
  if cardinality(p_wallet_ids) <> (select count(distinct x) from unnest(p_wallet_ids) x) then
    raise exception 'the same account is listed twice in that set';
  end if;

  select count(*) into v_count from public.wallets w
   where w.id = any(p_wallet_ids) and public.is_wallet_member(w.id);
  if v_count <> cardinality(p_wallet_ids) then
    raise exception 'not a member of every account in that set';
  end if;

  if exists (
    select 1 from public.wallets w
    where w.id = any(p_wallet_ids) and w.archived_at is not null
  ) then
    raise exception 'an archived account cannot be part of a budget';
  end if;

  if exists (
    select 1 from public.wallets w
    where w.id = any(p_wallet_ids) and w.currency_code <> v_budget.currency_code
  ) then
    raise exception 'every account in a budget must use the budget''s own currency';
  end if;

  -- The duplicate rule set_budget applies at creation, applied to the
  -- edit: no OTHER budget may already be (this month, this category, this
  -- exact set). Without it an edit could manufacture the exact duplicate a
  -- create refuses -- two rows that render identically, with nothing to
  -- say which is which.
  v_key := (select string_agg(x::text, ',' order by x) from unnest(p_wallet_ids) x);
  select b.id into v_clash
    from public.budgets b
   where b.id <> p_budget_id
     and b.period_start = v_budget.period_start
     and b.category_id is not distinct from v_budget.category_id
     and (select string_agg(bw.wallet_id::text, ',' order by bw.wallet_id)
            from public.budget_wallets bw where bw.budget_id = b.id) = v_key
   limit 1;
  if v_clash is not null then
    raise exception 'a budget over that set already exists';
  end if;

  delete from public.budget_wallets where budget_id = p_budget_id;
  insert into public.budget_wallets (budget_id, wallet_id, space_id)
  select p_budget_id, x, v_budget.space_id from unnest(p_wallet_ids) x;

  return p_budget_id;
end $$;

revoke all on function update_budget_wallets(uuid, uuid[]) from public, anon;
grant execute on function update_budget_wallets(uuid, uuid[]) to authenticated;
