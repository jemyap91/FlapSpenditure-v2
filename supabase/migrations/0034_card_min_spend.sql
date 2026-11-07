-- ═════════════════════════════════════════════════════════════════════════
-- 0034: min-spend cards
-- ═════════════════════════════════════════════════════════════════════════
-- Some cards earn on any channel once a minimum is spent, rather than on one
-- channel up to a max. bonus_cap_minor with a null bonus_channel now means
-- that: all of the wallet's spend counts towards it, and nothing is a
-- mismatch, which channel_mismatch (0033) already gives for a null channel.

alter table wallets
  drop constraint wallets_bonus_cap_needs_terms,
  add constraint wallets_bonus_cap_needs_terms
    check (bonus_cap_minor is null or cycle_start_day is not null);
