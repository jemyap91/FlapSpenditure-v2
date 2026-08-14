-- supabase/migrations/0007_seed_user.sql
-- Fires on auth.users insert so a brand-new user is never empty on first
-- login: one profiles row plus the 16 default categories from spec §3.6.
--
-- search_path is set to '' (empty), not 'public' -- Postgres searches
-- pg_temp for unqualified relation names before consulting search_path at
-- all, so `set search_path = public` alone would not stop a caller from
-- creating a temp table named profiles or categories and redirecting these
-- inserts into it (see migrations 0002 and 0004 for the same reasoning,
-- and the demonstrated pg_temp-shadowing exploit in supabase/tests/rls.sql
-- section 7). This trigger is SECURITY DEFINER by necessity -- the
-- triggering role has no INSERT grant on public.profiles/public.categories
-- during signup -- so an unqualified reference here would be directly
-- exploitable. Every reference below is schema-qualified.
--
-- Resilience: this trigger runs inside the same transaction that creates
-- the auth.users row, so if it raises, account creation fails outright.
-- `on conflict do nothing` on both inserts makes a re-run (a retried
-- signup webhook, a manual re-fire, or a profiles/categories row that
-- already exists for this id for any reason) a silent no-op instead of a
-- failed signup: a partially-seeded account (e.g. profile present, some
-- categories missing) is a recoverable, low-severity state the app can
-- backfill later (Task 15/17); a hard failure here blocks the user from
-- ever signing up at all, which is strictly worse. The categories
-- ON CONFLICT targets the same partial unique index the schema already
-- enforces (owner_id, kind, lower(btrim(name))) where archived_at is null,
-- so it also protects against this insert colliding with a category a
-- concurrent process already created for the same new user.
create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
    values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;

  -- 12 expense categories against 8 colour slots: slots repeat by design (§3.6).
  insert into public.categories (owner_id, name, kind, color_slot, icon, sort_order, is_default) values
    (new.id,'Groceries',    'expense',1,'shopping-basket', 1,true),
    (new.id,'Eating out',   'expense',2,'utensils',        2,true),
    (new.id,'Transport',    'expense',3,'bus',             3,true),
    (new.id,'Housing',      'expense',4,'house',           4,true),
    (new.id,'Utilities',    'expense',5,'plug',            5,true),
    (new.id,'Health',       'expense',6,'heart-pulse',     6,true),
    (new.id,'Entertainment','expense',7,'clapperboard',    7,true),
    (new.id,'Shopping',     'expense',8,'shopping-bag',    8,true),
    (new.id,'Travel',       'expense',1,'plane',           9,true),
    (new.id,'Education',    'expense',2,'graduation-cap', 10,true),
    (new.id,'Subscriptions','expense',3,'repeat',         11,true),
    (new.id,'Other',        'expense',4,'circle-ellipsis',12,true),
    (new.id,'Salary',       'income', 3,'wallet',          1,true),
    (new.id,'Bonus',        'income', 5,'gift',            2,true),
    (new.id,'Interest',     'income', 6,'piggy-bank',      3,true),
    (new.id,'Other income', 'income', 8,'circle-plus',     4,true)
  on conflict (owner_id, kind, (lower(btrim(name)))) where archived_at is null do nothing;

  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
