-- supabase/migrations/0011_final_review_fixes.sql
--
-- Whole-branch final review, fix 3: get_category_breakdown must merge
-- same-named categories across the wallets it is asked about.
--
-- 0006 defined the function grouping by (c.id, c.name, c.color_slot,
-- c.icon). That was correct while a category belonged to a USER: there was
-- exactly one "Groceries" row per person. 0008 moved categories to the
-- WALLET and its backfill copied each user's list into every wallet they
-- owned, so "Groceries" now exists once PER WALLET -- same name, same
-- color_slot, different id.
--
-- The dashboard (src/app/(app)/page.tsx) passes EVERY active same-currency
-- wallet id in a single call, so grouping by c.id renders one row per
-- wallet: "Groceries" listed twice, in the identical colour, with the
-- month's real total split between the two rows and each mini-bar
-- understating the category's actual share. Nothing on screen says the two
-- rows are the same category. This hits ordinary multi-wallet users, not
-- only people who share, and it is guaranteed for the flow this feature
-- creates -- onboard into your own wallet (16 seeded categories), then
-- accept an invitation to somebody else's (16 more, same names).
--
-- Grouping by (c.kind, lower(btrim(c.name))) is the same key
-- categories_unique_active_name uses per wallet, and the same key 0008's
-- own backfill matched transactions on -- so "the same category in two
-- wallets" means here exactly what it meant there. c.kind is part of the
-- key because a wallet may legitimately hold an expense AND an income
-- category of the same name (the unique index is per-kind), and those must
-- never merge into one another. In practice only expense rows reach the
-- grouping at all -- the `t.kind = 'expense'` filter below is unchanged --
-- but the grouping key does not rely on that filter to stay correct.
--
-- REPRESENTATIVES, and why each is deterministic. A merged group has more
-- than one candidate for the three columns that are not the grouping key,
-- so each is reduced to a single value that does not depend on scan or
-- join order:
--
--   category_id  (array_agg(c.id order by c.id))[1] -- the lexicographically
--                lowest member id. `min(uuid)` does not exist in
--                PostgreSQL (verified against this project's own local
--                stack: "ERROR: function min(uuid) does not exist"), so the
--                ordered-aggregate form is used instead. This is a stable
--                React key and a stable identity for the merged row; it is
--                NOT a claim that the row belongs to that one wallet, and
--                nothing in the app dereferences it back to a category.
--   color_slot   min(c.color_slot) -- the merged copies almost always share
--                a slot already (0008 copied it verbatim, and
--                seed_wallet_categories assigns the same slot to the same
--                seeded name in every wallet), so this only decides the
--                rare case where a user later recoloured one wallet's copy.
--                Lowest wins, deterministically.
--   icon         min(c.icon) -- same reasoning as color_slot, alphabetical
--                on the icon name.
--   name         min(c.name) -- the grouping key is the CASEFOLDED, trimmed
--                name, so two copies may differ in case or padding
--                ("Groceries" vs " groceries"). The lowest by collation is
--                picked so the label is stable across calls rather than
--                whichever copy the planner happened to emit first.
--
-- Everything else is deliberately unchanged from 0006: the return
-- signature (create or replace requires it), the one-shot is_wallet_member
-- guard including its every-element semantics (one unauthorised id in the
-- array denies the WHOLE call and returns empty, so a mixed array cannot be
-- used to probe), the deleted_at / kind / date filters, the
-- `security definer set search_path = ''` hardening, and full schema
-- qualification of every identifier.
create or replace function get_category_breakdown(
  wallet_ids uuid[], from_date date, to_date date
) returns table(category_id uuid, name text, color_slot smallint, icon text, total_minor bigint)
  language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from unnest(wallet_ids) w(id) where not public.is_wallet_member(w.id)) then
    return;
  end if;

  return query
    select (array_agg(c.id order by c.id))[1],
           min(c.name),
           min(c.color_slot),
           min(c.icon),
           sum(-t.amount_minor)::bigint
    from public.transactions t
    join public.categories c on c.id = t.category_id
    where t.wallet_id = any(wallet_ids)
      and t.deleted_at is null
      and t.kind = 'expense'          -- transfers (and income) are excluded from this report (§3.3)
      and t.occurred_on between from_date and to_date
    group by c.kind, lower(btrim(c.name))
    order by 5 desc;
end $$;
