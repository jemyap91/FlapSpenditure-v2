-- supabase/migrations/0019_wallet_groups.sql

-- Grouping and manual ordering for the wallets list, held PER USER.
--
-- Wallets are shared (wallet_members), so the alternative — `group_id` and
-- `sort_order` as columns on `wallets` — would mean one member dragging a
-- wallet rearranges every other member's screen, silently and with no way to
-- opt out. A household's two people can reasonably want different views of
-- the same set of wallets. That makes this per-user state about a shared
-- object, which is its own table rather than a column.
--
-- Alphabetical and date-added ordering need no storage at all: they are
-- derived from `wallets.name` and `wallets.created_at`, which every member
-- already reads. Only manual ordering and grouping need anything persisted,
-- and only `profiles.wallet_sort` records which of the three is in force.

-- ─────────────────────────────────────────────────────────────────────────
-- wallet_groups — a user's own labels ("Everyday", "Savings", "Business")
-- ─────────────────────────────────────────────────────────────────────────
create table wallet_groups (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 40),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Case-insensitive per user, matching categories_unique_active_name's
-- treatment of a name the user types and expects to be unique to them.
-- Unconditional rather than partial: groups have no archived state, so
-- there is no "freed after archiving" case to carve out.
create unique index wallet_groups_unique_name
  on wallet_groups (user_id, lower(btrim(name)));

create index wallet_groups_user on wallet_groups (user_id, sort_order);

-- The referencable half of the composite FK below. `id` is already unique as
-- the primary key; this pairs it with `user_id` so another table can
-- reference BOTH and have Postgres enforce that they belong together.
alter table wallet_groups add constraint wallet_groups_id_user unique (id, user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- wallet_prefs — how one user arranges one wallet
-- ─────────────────────────────────────────────────────────────────────────
create table wallet_prefs (
  user_id    uuid not null references auth.users(id) on delete cascade,
  wallet_id  uuid not null references wallets(id) on delete cascade,
  group_id   uuid references wallet_groups(id) on delete set null,
  sort_order integer not null default 0,
  primary key (user_id, wallet_id)
);

create index wallet_prefs_user on wallet_prefs (user_id, sort_order);

-- The invariant that makes grouping safe, and the same composite-FK shape
-- this codebase already uses for `transactions_category_same_wallet` and
-- `recurring_rules`: a row may only point at a group belonging to the SAME
-- user. Without it, `group_id` is an arbitrary uuid and one user could file
-- their wallet into another user's group — which, once the UI reads groups
-- by id, would show that group's name to someone it does not belong to.
--
-- `on delete set null` on the group reference above, deliberately not
-- cascade: deleting a group must not delete the user's arrangement of the
-- wallets that were in it, exactly as 0015 chose SET NULL for
-- `transactions.recurring_id` so that deleting a rule never deletes money
-- already spent. An ungrouped wallet simply returns to the ungrouped list.
alter table wallet_prefs add constraint wallet_prefs_group_same_user
  foreign key (group_id, user_id) references wallet_groups (id, user_id)
  on delete set null (group_id);

-- ─────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────
alter table wallet_groups enable row level security;
alter table wallet_prefs  enable row level security;

-- Ownership-scoped, not membership-scoped, and that distinction is load
-- bearing. `is_wallet_member(x)` is true for several different wallets at
-- once, which is what let a `using`/`with check` pair on `categories` be
-- satisfied on two DIFFERENT wallets and move a row between them (0018).
-- `user_id = auth.uid()` names one identity, so old row and new row cannot
-- disagree about whose it is.
create policy wallet_groups_own on wallet_groups for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- The `with check` carries a second clause the `using` does not: a user may
-- only record a preference about a wallet they can actually see. Without it
-- any uuid would be insertable, and a foreign key violation versus a
-- successful insert would answer "does this wallet id exist?" for a caller
-- who has no business asking. Reads need no such clause — a stale row for a
-- wallet they have since left is their own harmless leftover.
create policy wallet_prefs_own on wallet_prefs for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_wallet_member(wallet_id));

-- ─────────────────────────────────────────────────────────────────────────
-- Grants — column-scoped from the start
-- ─────────────────────────────────────────────────────────────────────────
-- 0004:33's blanket revoke only covered tables that existed then, and the
-- default ACL grants new tables to nobody in particular — but Supabase's
-- own `alter default privileges` can and does hand `anon` and
-- `authenticated` full rights on tables created later. Naming the grants
-- explicitly, after an explicit revoke, is the only way to know what these
-- two tables actually expose. Three tables in this schema reached
-- production carrying a table-wide UPDATE grant nobody chose; these do not.
revoke all on wallet_groups from anon, authenticated;
revoke all on wallet_prefs  from anon, authenticated;

grant select, insert, delete on wallet_groups to authenticated;
-- Not `user_id`: re-pointing a group at another user is the escalation this
-- table's composite FK and policy exist to prevent, and nothing in the app
-- ever rewrites it. Not `id` or `created_at` — identity and provenance.
grant update (name, sort_order) on wallet_groups to authenticated;

grant select, insert, delete on wallet_prefs to authenticated;
-- `group_id` and `sort_order` are the whole point of the row. `user_id` and
-- `wallet_id` together are the primary key: changing either is not an edit,
-- it is a different row, and DELETE + INSERT already expresses that under
-- the same policy.
grant update (group_id, sort_order) on wallet_prefs to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Which ordering the user last chose
-- ─────────────────────────────────────────────────────────────────────────
-- On `profiles` rather than in localStorage so the choice follows the user
-- between devices, which is the whole reason it is worth storing at all —
-- and a CHECK rather than a Postgres enum because adding a value to an enum
-- cannot run inside a transaction with other DDL, and this is a closed set
-- of three that the application also validates.
alter table profiles
  add column wallet_sort text not null default 'manual'
    check (wallet_sort in ('manual', 'name', 'created'));

-- `profiles` carries a table-wide UPDATE grant (audited 2026-09-03). It is
-- not escalatable — `profiles_own` is `id = auth.uid()` on both halves, so
-- there is no second row a user could move a profile to — so tightening it
-- is a separate piece of housekeeping and not this migration's business.
-- The column is reachable under the existing grant; nothing more is needed.
