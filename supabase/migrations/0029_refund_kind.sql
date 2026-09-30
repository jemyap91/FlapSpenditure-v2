-- supabase/migrations/0029_refund_kind.sql
--
-- Refunds, part 1 of 3 (docs/superpowers/specs/2026-09-30-refunds-design.md).
-- Alone in its file on purpose: Postgres refuses to USE an enum value inside
-- the transaction that added it, and the migration runner commits per file.
-- Everything that mentions 'refund' lives in 0030.
alter type public.txn_kind add value if not exists 'refund';
