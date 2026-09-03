-- supabase/migrations/0017_palette_16.sql

-- Three unrelated-looking changes travel together because they share one
-- deployment: the hosted database is migrated by hand (there is no `db push`
-- step in .github/workflows/ci.yml), so every extra migration is another
-- chance to forget one. Two of these are security repairs that have been
-- waiting on exactly that.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The categorical palette grows from 8 slots to 16
-- ─────────────────────────────────────────────────────────────────────────
--
-- 0002 gave both `wallets` and `categories` an inline
-- `check (color_slot between 1 and 8)`, which Postgres named
-- `<table>_color_slot_check` (verified against the live schema, not
-- assumed). The palette itself lives in palette.json and is enforced by
-- scripts/validate-palette.mjs in CI; this constraint is the database half
-- of the same contract, and the two have to move together or a legal colour
-- becomes an unwritable row.
--
-- Why 16 and not "as many as we like": the validator requires every ADJACENT
-- slot pair to stay at least 8.0 ΔE apart under simulated protanopia,
-- deuteranopia and tritanopia (Machado-Oliveira-Fernandes 2009, severity
-- 1.0), in BOTH themes, on top of a lightness band, a chroma floor and 3:1
-- contrast against the surface. A search across the sRGB gamut inside that
-- band reaches 17 slots before no ordering satisfies the rules at all. 16 is
-- that ceiling with a slot of headroom.
--
-- The original 8 are unchanged, deliberately: their hex values are what
-- every existing category already renders as, and regenerating the palette
-- would silently recolour every row in the table. The 8 added occupy the
-- cool arc (teal through violet) the original 8 never used — the widest
-- unoccupied stretch of the hue circle, which is also where the colour-
-- vision headroom was.
--
-- Widening a CHECK can never invalidate an existing row: every value that
-- satisfied `between 1 and 8` satisfies `between 1 and 16`. Postgres still
-- revalidates the table on ADD CONSTRAINT, which is cheap here and is why
-- this is written as drop-then-add rather than anything cleverer.

alter table wallets drop constraint wallets_color_slot_check;
alter table wallets add constraint wallets_color_slot_check
  check (color_slot between 1 and 16);

alter table categories drop constraint categories_color_slot_check;
alter table categories add constraint categories_color_slot_check
  check (color_slot between 1 and 16);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. `kind` stops being editable
-- ─────────────────────────────────────────────────────────────────────────
--
-- 0004_rls.sql:83 granted UPDATE on a named column list that includes
-- `kind`, and nothing since has revoked it. Grants are ADDITIVE across
-- migrations — a later migration naming a column does not replace an
-- earlier list — so `kind` has been writable by any wallet member for the
-- life of the app.
--
-- What that allows: a member of a shared wallet issuing
-- `PATCH /rest/v1/transactions?id=eq.<x>` with `{"kind":"income",
-- "amount_minor":500}`. Both columns are granted, and both sign CHECKs
-- (`expense_is_negative`, `income_is_positive`) are satisfied by the pair,
-- so an expense silently becomes income in someone else's ledger. RLS still
-- confines it to wallets the caller already belongs to, which is why this is
-- a data-shape hole rather than a privilege escalation — but the app has
-- never had a reason to write `kind` after insert. 0016's own
-- `updateTransaction` refuses a kind change in application code
-- (src/server/actions/transactions.ts), and spec §3.1 states plainly that
-- kind is not editable; this makes the database agree.
--
-- `kind → 'transfer'` was already impossible: `transfer_shape` requires a
-- non-null `transfer_id`, and `transfer_id` carries no UPDATE grant.
-- Revoking a single column leaves the rest of 0004:83's list intact.

revoke update (kind) on transactions from authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Re-assert 0004's revoke of table privileges from `anon`
-- ─────────────────────────────────────────────────────────────────────────
--
-- Drift, not a code defect. The hosted database was created by restoring a
-- dump from an earlier project, and the restore reinstated Supabase's stock
-- privileges — `GRANT ALL ... TO anon` on transactions, wallets, categories,
-- profiles, currencies, wallet_invites and wallet_members, plus the
-- matching ALTER DEFAULT PRIVILEGES — while 0004_rls.sql:33's
-- `revoke all on all tables in schema public from anon, authenticated` did
-- not come back with it. Found by `supabase db diff --linked`, which reports
-- the live schema rather than what the migrations say it should be.
--
-- Not currently exploitable: RLS is enabled on every table in `public`
-- (0001, 0004, 0009, 0012, 0013, 0015) and every policy is scoped `to
-- authenticated`, so `anon` reads zero rows whatever its table grants say.
-- The revoke matters because it is the layer that still holds if a future
-- policy is written permissively or RLS is disabled on one table during
-- debugging — defence in depth is only depth if the outer layer is actually
-- there.
--
-- Scoped to `anon` alone, never `anon, authenticated` as 0004 could safely
-- write it: 0004 revoked from both and then re-granted to `authenticated`
-- immediately afterwards. Repeating the two-role revoke HERE would strip
-- every grant 0004 through 0016 handed `authenticated` and leave the
-- application unable to read its own tables. `anon` is re-granted nothing,
-- because it is meant to hold nothing.

revoke all on all tables in schema public from anon;
alter default privileges for role postgres in schema public
  revoke all on tables from anon;

-- The same non-privilege table rights 0004:42 revokes by default but which
-- the restore also reinstated. Harmless to a client that cannot read a row,
-- but they are not privileges an application role has any use for.
revoke truncate, references, trigger, maintain on all tables in schema public
  from anon, authenticated;
