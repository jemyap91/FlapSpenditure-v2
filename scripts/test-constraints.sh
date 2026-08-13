#!/usr/bin/env bash
# scripts/test-constraints.sh
# Runs supabase/tests/constraints.sql (Task 6) against a freshly-reset local
# database. The file runs as the table-owning superuser (it intentionally
# bypasses RLS -- it exists to check CHECK-constraint invariants, not the
# RLS boundary; see supabase/tests/rls.sql for the RLS adversarial suite)
# and manages its own ON_ERROR_STOP / savepoint discipline internally, so
# this runner just resets and invokes it.
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

case "$DB_URL" in
  postgres://*@127.0.0.1:*|postgres://*@localhost:*|postgresql://*@127.0.0.1:*|postgresql://*@localhost:*)
    ;;
  *)
    echo "refusing to run: DB_URL must point at a loopback host (127.0.0.1/localhost)." >&2
    echo "got: $DB_URL" >&2
    exit 1
    ;;
esac

npx supabase db reset --no-seed >/dev/null
psql "$DB_URL" -f supabase/tests/constraints.sql
echo "constraints tests passed"
