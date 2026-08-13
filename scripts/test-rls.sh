#!/usr/bin/env bash
# scripts/test-rls.sh
# Runs supabase/tests/rls.sql against a freshly-reset local database.
# The test file impersonates two distinct users via `set local role
# authenticated` + `set local request.jwt.claims` inside explicit
# transactions, so it exercises RLS for real instead of running as the
# table-owning superuser (see supabase/tests/rls.sql for details).
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
npx supabase db reset --no-seed >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
echo "RLS tests passed"
