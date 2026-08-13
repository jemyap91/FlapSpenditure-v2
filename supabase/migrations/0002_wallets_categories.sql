-- supabase/migrations/0002_wallets_categories.sql
create table wallets (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null references auth.users(id) on delete cascade,
  name                   text not null check (length(btrim(name)) between 1 and 60),
  kind                   wallet_kind not null,
  currency_code          char(3) not null references currencies(code),
  starting_balance_minor bigint not null default 0,
  color_slot             smallint not null check (color_slot between 1 and 8),
  icon                   text not null,
  archived_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table wallet_members (
  wallet_id uuid not null references wallets(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      member_role not null default 'owner',
  joined_at timestamptz not null default now(),
  primary key (wallet_id, user_id)
);

create table categories (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 40),
  kind        category_kind not null,
  color_slot  smallint not null check (color_slot between 1 and 8),
  icon        text not null,
  sort_order  integer not null default 0,
  is_default  boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Case-insensitive, scoped to ACTIVE rows so a name frees up after archiving (spec §5.3)
create unique index categories_unique_active_name
  on categories (owner_id, kind, lower(name))
  where archived_at is null;

create index wallets_owner    on wallets (owner_id) where archived_at is null;
create index categories_owner on categories (owner_id, kind) where archived_at is null;

-- Every wallet's creator is automatically its owner-member.
create function add_owner_as_member() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into wallet_members (wallet_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end $$;

create trigger wallets_add_owner after insert on wallets
  for each row execute function add_owner_as_member();
