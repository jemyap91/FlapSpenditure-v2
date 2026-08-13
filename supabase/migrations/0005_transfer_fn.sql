-- supabase/migrations/0005_transfer_fn.sql

-- A transfer is TWO rows sharing a transfer_id (spec §3.2). A client could
-- write both atomically with one multi-row insert — the reason this lives in
-- Postgres is the INVARIANT, not atomicity: distinct wallets, positive inputs,
-- membership on both sides, and opposite signs, enforced for every caller.
-- amount_out is POSITIVE from the caller; this function applies the signs.
--
-- security invoker is deliberate (kept from the brief) — unlike
-- is_wallet_member, this function *should* run under the caller's RLS so a
-- user cannot transfer out of a wallet they don't belong to. The explicit
-- is_wallet_member guard below is belt-and-braces: without it RLS would
-- still reject the insert, but with a far worse error message.
--
-- search_path is nonetheless set to '' here, not 'public' as the brief had
-- it, with every reference below schema-qualified (public.wallets,
-- public.transactions, public.is_wallet_member, auth.uid()). The
-- pg_temp-shadowing hole this closes for SECURITY DEFINER functions (see
-- 0002/0004) is not a privilege-escalation vector here, since this function
-- runs as the invoker and a caller shadowing their own session can only
-- sabotage their own call, not another user's data. It is applied anyway
-- for consistency with the rest of this branch's functions and because an
-- unqualified `wallets`/`transactions` reference silently resolving to a
-- caller-created temp table would otherwise let the currency lookup or the
-- insert itself go quietly nowhere instead of raising.
create function create_transfer(
  from_wallet uuid, to_wallet uuid,
  amount_out bigint, amount_in bigint,
  on_date date, note text default null
) returns uuid
  language plpgsql security invoker set search_path = '' as $$
declare
  tid uuid := gen_random_uuid();
  from_ccy char(3);
  to_ccy   char(3);
begin
  if from_wallet = to_wallet then
    raise exception 'cannot transfer to the same wallet';
  end if;
  if amount_out <= 0 or amount_in <= 0 then
    raise exception 'transfer amounts must be positive';
  end if;
  if not public.is_wallet_member(from_wallet) or not public.is_wallet_member(to_wallet) then
    raise exception 'not a member of both wallets';
  end if;

  select currency_code into from_ccy from public.wallets where id = from_wallet;
  select currency_code into to_ccy   from public.wallets where id = to_wallet;

  insert into public.transactions
    (wallet_id, created_by, kind, amount_minor, currency_code, transfer_id, occurred_on, note)
  values
    (from_wallet, auth.uid(), 'transfer', -amount_out, from_ccy, tid, on_date, note),
    (to_wallet,   auth.uid(), 'transfer',  amount_in,  to_ccy,   tid, on_date, note);

  return tid;
end $$;
