#!/usr/bin/env bash
# scripts/test-rls.sh
# Runs supabase/tests/rls.sql against a freshly-reset local database.
# The test file impersonates two distinct users via `set local role
# authenticated` + `set local request.jwt.claims` inside explicit
# transactions, so it exercises RLS for real instead of running as the
# table-owning superuser (see supabase/tests/rls.sql for details).
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# This suite plays the attacker: it runs unfiltered bulk UPDATE/DELETE
# statements expecting RLS to reduce them to zero affected rows. DB_URL is
# kept overridable (useful for a non-default local port), but pointed at
# anything reachable over the network that isn't loopback, those statements
# would be genuinely destructive. Refuse rather than guess.
#
# The check itself now lives in scripts/require-loopback.sh (Task 7), so the
# three suites that need it share ONE implementation instead of three copies
# that can drift; its comments explain why the host is parsed rather than
# glob-matched.
# shellcheck source=scripts/require-loopback.sh
. "$(dirname "${BASH_SOURCE[0]}")/require-loopback.sh"
require_loopback "$DB_URL" DB_URL

npx supabase db reset --no-seed >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
echo "RLS tests passed"
