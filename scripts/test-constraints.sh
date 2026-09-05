#!/usr/bin/env bash
# scripts/test-constraints.sh
# Runs supabase/tests/constraints.sql (Task 6) against a freshly-reset local
# database. The file runs as the table-owning superuser (it intentionally
# bypasses RLS -- it exists to check CHECK-constraint invariants, not the
# RLS boundary; see supabase/tests/rls.sql for the RLS adversarial suite)
# and manages its own ON_ERROR_STOP / savepoint discipline internally, so
# this runner just resets and invokes it.
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54332/postgres}"

# Same guard as scripts/test-rls.sh, and for the same reason -- parse the
# actual host libpq would connect to, rather than substring-matching the
# raw URL (see scripts/require-loopback.sh, where the shared implementation
# and that reasoning now live).
# shellcheck source=scripts/require-loopback.sh
. "$(dirname "${BASH_SOURCE[0]}")/require-loopback.sh"
require_loopback "$DB_URL" DB_URL

npx supabase db reset --no-seed >/dev/null

# `db reset` restarts containers after migrating, and the database can still
# be coming back when the very next psql connects -- observed as "server
# closed the connection unexpectedly" and, once, a half-initialised schema.
# Wait for it rather than racing it.
for _ in $(seq 1 60); do
  psql "$DB_URL" -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
psql "$DB_URL" -f supabase/tests/constraints.sql
echo "constraints tests passed"
