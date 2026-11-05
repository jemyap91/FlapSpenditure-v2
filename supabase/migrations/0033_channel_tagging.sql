-- 0033: expense channels, card bonus terms, and per-merchant channel memory.
--
-- A channel says HOW an expense was paid (online, in store, ...). A card can
-- carry bonus terms -- "6% on online spend, up to $X a cycle, cycle starting
-- on day N" -- and an expense whose channel differs from its card's bonus
-- channel is flagged as a mismatch.
--
-- Channel is nullable and never backfilled: a null channel is "not said",
-- and is never a mismatch.

create type expense_channel as enum ('online', 'in_store', 'bill', 'paynow_transfer', 'overseas');

-- ─────────────────────────────────────────────────────────────────────────
-- transactions.channel
-- ─────────────────────────────────────────────────────────────────────────
alter table transactions add column channel expense_channel;
alter table transactions add constraint transactions_channel_expense_only
  check (channel is null or kind = 'expense');

-- INSERT on transactions is a table-level grant (0004), so the new column is
-- insertable already. UPDATE is column-scoped (0004/0016), so extend it.
grant update (channel) on transactions to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- wallets: bonus terms
-- ─────────────────────────────────────────────────────────────────────────
alter table wallets
  add column bonus_channel   expense_channel,
  add column cycle_start_day smallint,
  add column bonus_cap_minor bigint;

alter table wallets
  add constraint wallets_cycle_start_day_range check (cycle_start_day between 1 and 31),
  add constraint wallets_bonus_cap_positive    check (bonus_cap_minor > 0),
  add constraint wallets_bonus_cap_needs_terms
    check (bonus_cap_minor is null
           or (bonus_channel is not null and cycle_start_day is not null));

-- UPDATE on wallets is column-scoped since 0022 and owner-only by RLS. The
-- bonus columns are deliberately left out of that grant: a wallet MEMBER (not
-- just the owner) sets them, through set_wallet_bonus below, which is their
-- only write route.

create function set_wallet_bonus(
  p_wallet_id       uuid,
  p_channel         expense_channel,
  p_cycle_start_day smallint,
  p_cap_minor       bigint
) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_wallet_member(p_wallet_id) then
    raise exception 'that account does not exist';
  end if;

  update public.wallets
     set bonus_channel   = p_channel,
         cycle_start_day = p_cycle_start_day,
         bonus_cap_minor = p_cap_minor
   where id = p_wallet_id;
end $$;

revoke all on function set_wallet_bonus(uuid, expense_channel, smallint, bigint) from public, anon;
grant execute on function set_wallet_bonus(uuid, expense_channel, smallint, bigint) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- merchant_channels: the channel last used for a merchant, per household
-- ─────────────────────────────────────────────────────────────────────────
create table merchant_channels (
  space_id     uuid not null references spaces(id) on delete cascade,
  merchant_key text not null check (merchant_key = lower(btrim(merchant_key))),
  channel      expense_channel not null,
  updated_at   timestamptz not null default now(),
  primary key (space_id, merchant_key)
);

alter table merchant_channels enable row level security;
create policy merchant_channels_space on merchant_channels
  for all to authenticated
  using (is_space_member(space_id)) with check (is_space_member(space_id));

-- This project's default ACL gives authenticated no DML (0004), so a policy
-- without a grant is dead code.
revoke all on merchant_channels from anon, authenticated;
grant select, insert, update, delete on merchant_channels to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- channel_mismatch
-- ─────────────────────────────────────────────────────────────────────────
-- PostgREST computed field, like effective_category_id (0030): true only when
-- the row's channel and its wallet's bonus_channel are both set and differ.
-- Selectable, and filterable as .filter("channel_mismatch", "eq", true).
create function public.channel_mismatch(public.transactions)
  returns boolean
  language sql stable as $$
  select coalesce(
    (select $1.channel <> w.bonus_channel
       from public.wallets w
      where w.id = $1.wallet_id),
    false)
$$;
