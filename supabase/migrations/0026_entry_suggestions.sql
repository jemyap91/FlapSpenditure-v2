-- supabase/migrations/0026_entry_suggestions.sql
--
-- Suggestions for the Note and Merchant fields on the transaction form,
-- drawn from what THIS user typed before. Nothing is learned or stored:
-- this is a read over rows the caller already created, computed when the
-- form loads and handed to a native <datalist>.
--
-- Only the caller's own entries (`created_by = auth.uid()`), by decision
-- (2026-09-07): a housemate's usual merchants in a shared wallet do not
-- suggest for you until you have used them yourself. That also means the
-- function needs no membership join at all -- the one filter is the
-- boundary, and it is narrower than what the caller can read anyway.
--
-- SECURITY DEFINER for the same reason as get_wallet_members (0010):
-- `transactions` is readable under members_select, so an invoker-rights
-- function would work too, but the definer form keeps this read's shape
-- fixed by the function body rather than by whatever RLS happens to allow,
-- and `set search_path = ''` closes the pg_temp hijack 0004 documents.
--
-- Shape: one row per distinct (merchant, note) pair, both normalised by
-- lower(btrim(...)) so "NTUC" and " ntuc " are one merchant. The spelling
-- returned is the one the user typed most recently. `category_id` is the
-- category most often paired with that pair, so the form can prefill it
-- when a merchant is picked. Transfers carry no category and no merchant
-- on creation, so they are excluded. Twelve months and 200 rows keep the
-- payload small for any realistic history.
create function get_entry_suggestions()
  returns table(merchant text, note text, category_id uuid, uses int, last_used date)
  language sql stable security definer set search_path = '' as $$
  with mine as (
    select nullif(btrim(t.merchant), '') as merchant,
           nullif(btrim(t.note), '')     as note,
           t.category_id,
           t.occurred_on
      from public.transactions t
     where t.created_by = auth.uid()
       and t.deleted_at is null
       and t.kind <> 'transfer'
       and t.occurred_on >= (current_date - interval '12 months')::date
       and (nullif(btrim(t.merchant), '') is not null or nullif(btrim(t.note), '') is not null)
  ),
  spelled as (
    select m.merchant, m.note, m.category_id, m.occurred_on,
           lower(m.merchant) as mkey,
           lower(m.note)     as nkey,
           first_value(m.merchant) over (partition by lower(m.merchant)
                                         order by m.occurred_on desc, m.merchant) as merchant_spelling,
           first_value(m.note)     over (partition by lower(m.merchant), lower(m.note)
                                         order by m.occurred_on desc, m.note) as note_spelling
      from mine m
  )
  select s.merchant_spelling,
         s.note_spelling,
         mode() within group (order by s.category_id),
         count(*)::int,
         max(s.occurred_on)
    from spelled s
   group by s.mkey, s.nkey, s.merchant_spelling, s.note_spelling
   order by count(*) desc, max(s.occurred_on) desc
   limit 200
$$;

revoke all on function get_entry_suggestions() from public, anon;
grant execute on function get_entry_suggestions() to authenticated;
