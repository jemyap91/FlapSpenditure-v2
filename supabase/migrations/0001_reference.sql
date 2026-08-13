-- supabase/migrations/0001_reference.sql
create type wallet_kind   as enum ('card', 'bank');
create type txn_kind      as enum ('expense', 'income', 'transfer');
create type category_kind as enum ('expense', 'income');
create type member_role   as enum ('owner', 'member');
create type theme_pref    as enum ('system', 'light', 'dark');

create table currencies (
  code       char(3) primary key,
  minor_unit smallint not null check (minor_unit between 0 and 4),
  symbol     text not null,
  name       text not null
);

insert into currencies (code, minor_unit, symbol, name) values
  ('USD',2,'$','US Dollar'),        ('EUR',2,'€','Euro'),
  ('GBP',2,'£','Pound Sterling'),   ('AUD',2,'A$','Australian Dollar'),
  ('CAD',2,'C$','Canadian Dollar'), ('SGD',2,'S$','Singapore Dollar'),
  ('CHF',2,'CHF','Swiss Franc'),    ('CNY',2,'¥','Chinese Yuan'),
  ('JPY',0,'¥','Japanese Yen'),     ('KRW',0,'₩','South Korean Won'),
  ('KWD',3,'KD','Kuwaiti Dinar');

create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  base_currency char(3) not null default 'USD' references currencies(code),
  theme         theme_pref not null default 'system',
  created_at    timestamptz not null default now()
);

alter table currencies enable row level security;
alter table profiles   enable row level security;

create policy currencies_read on currencies
  for select to authenticated using (true);

create policy profiles_own on profiles
  for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
