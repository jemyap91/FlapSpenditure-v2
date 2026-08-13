-- supabase/migrations/0004_rls.sql

-- SECURITY DEFINER is REQUIRED, not stylistic (spec §4.1): without it, the
-- wallets policy queries wallet_members whose policy queries wallets, and
-- Postgres raises "infinite recursion detected in policy".
-- SET search_path is mandatory — without it a caller can point search_path at
-- their own wallet_members table and escalate.
create function is_wallet_member(w uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from wallet_members
    where wallet_id = w and user_id = auth.uid()
  )
$$;

alter table wallets        enable row level security;
alter table wallet_members enable row level security;
alter table categories     enable row level security;
alter table transactions   enable row level security;

-- Members can SEE a wallet; only the owner can CHANGE it (spec §4).
create policy wallets_select on wallets
  for select to authenticated using (is_wallet_member(id));
create policy wallets_write on wallets
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy members_select on wallet_members
  for select to authenticated using (is_wallet_member(wallet_id));
create policy members_write on wallet_members
  for all to authenticated
  using (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()));

create policy categories_own on categories
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy transactions_member on transactions
  for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));
