-- supabase/migrations/0003_transactions.sql
create table transactions (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references wallets(id) on delete cascade,
  created_by    uuid not null references auth.users(id),
  kind          txn_kind not null,
  amount_minor  bigint not null check (amount_minor <> 0),
  currency_code char(3) not null references currencies(code),
  category_id   uuid references categories(id) on delete restrict,
  transfer_id   uuid,
  note          text check (note is null or length(note) <= 280),
  occurred_on   date not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  -- Spec §3.3 — the ledger cannot hold a nonsensical row.
  constraint expense_is_negative  check (kind <> 'expense'  or amount_minor < 0),
  constraint income_is_positive   check (kind <> 'income'   or amount_minor > 0),
  constraint transfer_shape       check (kind <> 'transfer' or (category_id is null and transfer_id is not null)),
  constraint non_transfer_no_link check (kind =  'transfer' or transfer_id is null)
);

create index transactions_wallet_date
  on transactions (wallet_id, occurred_on desc) where deleted_at is null;
create index transactions_category on transactions (category_id);
create index transactions_transfer on transactions (transfer_id);
