-- supabase/migrations/0024_household_members.sql
--
-- The /household screen lists who shares a category list with you. Space
-- membership itself is readable (space_members_select, 0022), but the NAMES
-- are on profiles, and profiles_own (0001) is `id = auth.uid()`, full stop
-- -- so a plain space_members -> profiles join shows a co-member as a bare
-- uuid. Same gap 0010 closed for wallets with get_wallet_members, closed
-- the same way: a SECURITY DEFINER read shaped to exactly the columns the
-- screen needs, self-scoped through the same is_space_member() the table's
-- own policy uses, so it can never return a household the caller is not in.
--
-- Explicit revoke/grant, as 0010 argues at length: display names are
-- identity-adjacent, and Postgres grants EXECUTE to PUBLIC on create.
create function get_space_members()
  returns table(space_id uuid, user_id uuid, display_name text, role member_role, joined_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select sm.space_id, sm.user_id, p.display_name, sm.role, sm.joined_at
  from public.space_members sm
  join public.profiles p on p.id = sm.user_id
  where public.is_space_member(sm.space_id)
$$;

revoke all on function get_space_members() from public, anon;
grant execute on function get_space_members() to authenticated;
