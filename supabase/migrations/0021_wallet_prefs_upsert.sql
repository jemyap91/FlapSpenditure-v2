-- supabase/migrations/0021_wallet_prefs_upsert.sql

-- Fixes a bug shipped by 0019: reordering a wallet worked once and then
-- reported "Could not save that order. Please try again." forever after.
--
-- ## Root cause
--
-- PostgREST's `.upsert(rows, { onConflict: "user_id,wallet_id" })` compiles
-- to `insert ... on conflict (...) do update set <every column supplied>`.
-- That SET list therefore names `user_id` and `wallet_id` as well as the
-- column being changed — and 0019 deliberately grants UPDATE on
-- `(group_id, sort_order)` only, because `user_id` and `wallet_id` together
-- ARE the primary key and re-pointing either is not an edit.
--
-- So the insert half is permitted (INSERT is granted table-wide, constrained
-- by `wallet_prefs_own`'s `with check`) while the update half is refused
-- with 42501 `permission denied for table wallet_prefs`. Reproduced exactly:
--
--   insert ... on conflict do update
--     set user_id = excluded.user_id, wallet_id = excluded.wallet_id,
--         sort_order = excluded.sort_order;   -- REFUSED
--   insert ... on conflict do update
--     set sort_order = excluded.sort_order;   -- succeeds
--
-- Which is why it failed intermittently rather than outright: the FIRST
-- arrangement of any wallet has no existing row, so it is a plain insert and
-- works. Every arrangement after that conflicts, and fails.
--
-- 0019's own RLS tests missed it because they insert into wallet_prefs
-- directly and never take the conflict path. The test added alongside this
-- migration calls each function TWICE for that reason.
--
-- ## The fix, and what it does NOT do
--
-- It does not widen the grant. Granting UPDATE on `user_id` would let a row
-- be re-pointed at another user, which is the whole reason the column is
-- excluded. Instead these two functions issue the statement PostgREST cannot
-- express: a DO UPDATE SET naming only the column that is actually changing.
--
-- Both are `security invoker`, so nothing about the security model changes —
-- `wallet_prefs_own` still applies to every row touched, including its
-- `with check` requirement that the caller be a member of the wallet, and
-- the same column grants still bound what the SET list may name. These
-- functions are a way to phrase a statement, not a way to escape a policy.
--
-- `set search_path = ''` for the same reason every other function here does
-- it: every reference is schema-qualified and none can be captured.

-- ─────────────────────────────────────────────────────────────────────────
-- The whole list, in order
-- ─────────────────────────────────────────────────────────────────────────
-- Takes the complete ordering rather than one wallet's position, matching
-- what `walletOrderInput` already sends and for the reason its doc comment
-- gives: positions are only meaningful relative to each other.
--
-- `with ordinality` supplies the position, so the ordering is derived from
-- the array's own order and the caller never sends indices that could
-- disagree with it.
create function set_wallet_order(p_wallet_ids uuid[]) returns void
  language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  -- A repeated id would make one wallet's position ambiguous AND make the
  -- statement touch the same primary key twice, which Postgres refuses with
  -- "ON CONFLICT DO UPDATE command cannot affect row a second time" — an
  -- error message about nothing the user did. The action checks this too;
  -- this is the half a direct RPC call cannot skip.
  if (select count(*) from unnest(p_wallet_ids)) <>
     (select count(distinct x) from unnest(p_wallet_ids) as t(x)) then
    raise exception 'that ordering repeats a wallet';
  end if;

  insert into public.wallet_prefs (user_id, wallet_id, sort_order)
  select auth.uid(), t.id, t.ord - 1
    from unnest(p_wallet_ids) with ordinality as t(id, ord)
  on conflict (user_id, wallet_id) do update
    -- ONLY sort_order. Naming user_id or wallet_id here is what broke.
    set sort_order = excluded.sort_order;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- One wallet's group
-- ─────────────────────────────────────────────────────────────────────────
-- `p_group_id` null is a real value, not "unset": it is how a wallet leaves
-- every group and returns to the ungrouped list.
create function set_wallet_group(p_wallet_id uuid, p_group_id uuid default null)
  returns void language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  insert into public.wallet_prefs (user_id, wallet_id, group_id)
  values (auth.uid(), p_wallet_id, p_group_id)
  on conflict (user_id, wallet_id) do update
    set group_id = excluded.group_id;
end $$;

grant execute on function set_wallet_order(uuid[]) to authenticated;
grant execute on function set_wallet_group(uuid, uuid) to authenticated;
