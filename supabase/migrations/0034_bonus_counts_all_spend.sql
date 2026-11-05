-- 0034: a card whose max is a spend quota every expense counts toward.
--
-- 0033's max is "the most spend on the bonus channel that earns the bonus".
-- Some cards work the other way: the bonus needs a minimum spend each cycle
-- (UOB One's $500), and every purchase counts toward it -- groceries paid in
-- store included -- even when only the bonus channel earns points directly.
-- `bonus_counts_all_spend` marks such a card: the tracker then sums every
-- expense in the cycle, not just the bonus channel's, while an expense on
-- another channel still says it doesn't earn the bonus itself.

alter table wallets
  add column bonus_counts_all_spend boolean not null default false;

-- Same route as the other bonus columns (0033): not in the wallets UPDATE
-- grant, set only through set_wallet_bonus, which any member may call. The
-- new argument defaults to false, so a caller that leaves it out (an older
-- client) clears it along with everything else it leaves out, exactly like
-- the three 0033 arguments.
drop function set_wallet_bonus(uuid, expense_channel, smallint, bigint);

create function set_wallet_bonus(
  p_wallet_id        uuid,
  p_channel          expense_channel default null,
  p_cycle_start_day  smallint        default null,
  p_cap_minor        bigint          default null,
  p_counts_all_spend boolean         default false
) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_wallet_member(p_wallet_id) then
    raise exception 'that account does not exist';
  end if;

  update public.wallets
     set bonus_channel          = p_channel,
         cycle_start_day        = p_cycle_start_day,
         bonus_cap_minor        = p_cap_minor,
         bonus_counts_all_spend = coalesce(p_counts_all_spend, false)
   where id = p_wallet_id;
end $$;

revoke all on function set_wallet_bonus(uuid, expense_channel, smallint, bigint, boolean) from public, anon;
grant execute on function set_wallet_bonus(uuid, expense_channel, smallint, bigint, boolean) to authenticated;
