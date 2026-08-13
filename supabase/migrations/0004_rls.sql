-- supabase/migrations/0004_rls.sql

-- SECURITY DEFINER is REQUIRED, not stylistic (spec §4.1): without it, the
-- wallets policy queries wallet_members whose policy queries wallets, and
-- Postgres raises "infinite recursion detected in policy".
-- search_path is set to '' (empty), not 'public' — Postgres searches pg_temp
-- for unqualified relation names before consulting search_path at all, so
-- `set search_path = public` alone does NOT stop a caller from creating a
-- temp table named wallet_members and redirecting this lookup to it. An empty
-- search_path forces every unqualified name to fail to resolve, so the body
-- below schema-qualifies both wallet_members and auth.uid() explicitly; this
-- also fails closed if a future edit adds an unqualified reference.
create function is_wallet_member(w uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.wallet_members
    where wallet_id = w and user_id = auth.uid()
  )
$$;

-- RLS filters rows WITHIN what a role may already touch; it never grants reach
-- to a table in the first place. This project's default ACL for schema public
-- gives anon/authenticated only TRUNCATE/REFERENCES/TRIGGER/MAINTAIN — no
-- SELECT/INSERT/UPDATE/DELETE — so without the grants below, the policies in
-- this migration (and the ones already on profiles/currencies from 0001) are
-- unreachable: every query from an authenticated user fails at the privilege
-- check before RLS is ever consulted. Worse, TRUNCATE is table-level and is
-- NOT subject to RLS at all, so leaving it granted would let any logged-in
-- user wipe every table regardless of policy. `revoke all` first closes that
-- hole and gives a clean, auditable baseline instead of layering onto an
-- unknown starting state; the grants that follow are scoped to exactly what
-- each table's policies below permit.
revoke all on all tables in schema public from anon, authenticated;

-- The revoke above only fixes tables that exist today. The default ACL for
-- schema public still hands anon/authenticated TRUNCATE/REFERENCES/TRIGGER/
-- MAINTAIN on anything created later, which would re-open the RLS-bypassing
-- TRUNCATE hole (with no offsetting DML grant, so the new table would also be
-- unreachable). Phase 1 creates no further tables, so this is durability, not
-- an open hole today — but it costs two lines to close for good.
alter default privileges in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

grant select on currencies to authenticated;

grant select, insert, update, delete
  on profiles, wallets, wallet_members, categories, transactions
  to authenticated;

-- transactions_member is `for all using (is_wallet_member(wallet_id)) with
-- check (is_wallet_member(wallet_id))`. On UPDATE, `using` sees the OLD row
-- and `with check` sees the NEW one -- both ask the identical question, so
-- anyone who is a member of two different wallets satisfies both while
-- moving a row between them: UPDATE transactions SET wallet_id = <other
-- wallet I belong to> silently exfiltrates another member's transaction out
-- of a wallet they own into one they have no access to. RLS cannot express
-- "wallet_id must not change" -- `with check` has no access to the old row
-- to compare against. Column-level privilege, evaluated before RLS even
-- runs, is the only mechanism that can close this: narrow the blanket
-- UPDATE grant above to the columns Phase 1 actually needs to edit. This
-- also closes a separate deferred finding for free -- excluding created_by
-- stops a member re-attributing a transaction to another user.
-- Excluded: id (never changes), wallet_id (see above; moving a transaction
-- between wallets is not a Phase 1 feature -- Task 16 is create/soft-delete/
-- restore, Task 20 is list+undo -- so reintroduce this deliberately with its
-- own checks if a later phase wants it), created_by (see above), and
-- transfer_id (prevents re-linking a row to an arbitrary transfer once Task
-- 9's create_transfer lands).
revoke update on transactions from authenticated;
grant update (kind, amount_minor, currency_code, category_id, occurred_on, note, deleted_at)
  on transactions to authenticated;

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
