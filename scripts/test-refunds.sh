#!/usr/bin/env bash
# scripts/test-refunds.sh
# Runs supabase/tests/refunds.sql (refunds plan, Tasks 1-2) against a
# freshly-reset local database. Same shape as scripts/test-constraints.sh.
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54332/postgres}"
# shellcheck source=scripts/require-loopback.sh
. "$(dirname "${BASH_SOURCE[0]}")/require-loopback.sh"
require_loopback "$DB_URL" DB_URL

npx supabase db reset --no-seed >/dev/null
for _ in $(seq 1 60); do
  psql "$DB_URL" -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/refunds.sql
echo "refunds tests passed"
