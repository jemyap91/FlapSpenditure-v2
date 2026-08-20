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
-- No explicit revoke/grant execute, matching get_wallet_balances/
-- get_category_breakdown/get_cash_flow in 0006: both functions self-filter
-- to the caller's own membership/email, so leaving EXECUTE at its default
-- (PUBLIC) grant is safe -- an anon caller has no auth.uid()/jwt email to
-- match against and gets zero rows back.

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
