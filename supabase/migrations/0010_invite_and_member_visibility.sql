-- supabase/migrations/0010_invite_and_member_visibility.sql
--
-- Task 8 (members + pending-invites UI on /wallets) needs two reads that
-- plain RLS-scoped SELECTs cannot satisfy, discovered while wiring the page:
--
-- 1. A member list with NAMES. `wallet_members` is visible to co-members
--    (members_select, 0004: `is_wallet_member(wallet_id)`), but `profiles`
--    is not -- `profiles_own` (0001) is `using (id = auth.uid())`, full
--    stop, so a PostgREST embed of `wallet_members -> profiles` returns
--    null for every row except the caller's own. Verified against the
--    local stack: `select policyname, qual from pg_policies where
--    tablename = 'profiles'` shows only `profiles_own`.
--
-- 2. A pending invite's WALLET NAME. `invites_invitee_select` (0009) lets
--    the invitee read the `wallet_invites` row, but the invitee is by
--    definition NOT YET a member of that wallet, so `wallets_select`
--    (`is_wallet_member(id)`) hides the row an embed would need to resolve
--    `wallet_id -> name`. An invitee can see there IS an invite but not
--    what it is for.
--
-- Both gaps are closed the same way 0006 closes the equivalent problem for
-- balances/breakdowns: a narrow, read-only SECURITY DEFINER function that
-- exposes only the specific columns the UI needs (never email, balance, or
-- owner_id) and re-derives its own scope rather than trusting a caller-
-- supplied filter -- get_wallet_members via the same is_wallet_member(...)
-- check the table's own RLS uses, get_pending_invites via the same
-- lower(btrim(email)) match invites_invitee_select uses. Neither widens
-- profiles_own or wallets_select themselves, so direct table access is
-- unchanged; only these two shaped, minimal reads are added.
--
-- Explicit revoke/grant below, matching 0009's accept_wallet_invite/
-- decline_wallet_invite rather than 0006's get_wallet_balances/
-- get_category_breakdown/get_cash_flow. 0006's functions return balances
-- and category aggregates; these two return DISPLAY NAMES and the NAMES of
-- wallets someone hasn't joined yet -- identity-adjacent data, the same
-- category 0009 draws its stricter line around, and 0009 revokes EXECUTE
-- explicitly even though it too has a NULL-email guard in its body. Postgres
-- grants EXECUTE to PUBLIC by default on CREATE FUNCTION, so without this,
-- `anon` could call both; today anon's JWT carries no `sub`/`email`, so
-- auth.uid() and auth.jwt()->>'email' are NULL and every WHERE comparison
-- below evaluates to NULL -- a real barrier, but one living inside a query
-- predicate, not at the privilege boundary. A future edit to either WHERE
-- clause (a fallback, a loosened comparison, different null handling) could
-- silently reopen these to anon with nothing at the grant level to stop it.
-- Revoking here removes that dependency entirely.
create function get_wallet_members()
  returns table(wallet_id uuid, user_id uuid, display_name text, role member_role)
  language sql stable security definer set search_path = '' as $$
  select wm.wallet_id, wm.user_id, p.display_name, wm.role
  from public.wallet_members wm
  join public.profiles p on p.id = wm.user_id
  where public.is_wallet_member(wm.wallet_id)
$$;

create function get_pending_invites()
  returns table(id uuid, wallet_id uuid, wallet_name text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select wi.id, wi.wallet_id, w.name, wi.created_at
  from public.wallet_invites wi
  join public.wallets w on w.id = wi.wallet_id
  where wi.status = 'pending'
    and lower(btrim(wi.invited_email)) = lower(btrim(auth.jwt() ->> 'email'))
$$;

revoke all on function get_wallet_members()  from public, anon;
revoke all on function get_pending_invites() from public, anon;
grant execute on function get_wallet_members()  to authenticated;
grant execute on function get_pending_invites() to authenticated;
