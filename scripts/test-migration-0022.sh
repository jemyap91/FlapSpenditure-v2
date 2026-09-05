#!/usr/bin/env bash
# scripts/test-migration-0022.sh
# Proves the 0022 and 0023 data migrations on a fixture rather than trusting them: resets
# the LOCAL database to 0021, plants wallet-scoped categories with the
# awkward cases (a renamed copy, an archived duplicate that is more used, an
# unrelated household, name-keyed budgets), applies 0022 then 0023, and
# asserts the result. See
# supabase/tests/migration_0022.sql for the fixture and every claim.
#
# The other suites run against a fully migrated database and so can never
# exercise the merge itself; this is the only place it is tested.
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54332/postgres}"

# Same loopback guard as the other runners, and for the same reason.
. "$(dirname "${BASH_SOURCE[0]}")/require-loopback.sh"

FIXTURE=supabase/tests/migration_0022.sql
MIGRATIONS="supabase/migrations/0022_space_scoped_categories.sql supabase/migrations/0023_budget_category_id.sql"

# `db reset` restarts containers after migrating, and the database can still
# be coming back when the very next psql connects. Wait for it rather than
# racing it.
wait_for_db() {
  for _ in $(seq 1 60); do
    psql "$DB_URL" -tAc 'select 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "database did not come back after reset" >&2
  exit 1
}

npx supabase db reset --no-seed --version 0021 >/dev/null
wait_for_db

# Fixture: everything above the marker.
sed '/^-- >>> ASSERT/,$d' "$FIXTURE" | psql "$DB_URL" -v ON_ERROR_STOP=1 -q

# Each migration in ONE transaction (-1): 0022 uses `on commit drop` temp
# tables, which autocommit mode would drop at the end of each statement, and
# whole-or-nothing is the shape the CLI applies them in. 0023 follows in its
# own transaction, exactly as it would on a real upgrade.
for m in $MIGRATIONS; do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -1 -f "$m"
done

# Assertions: everything below the marker.
sed -n '/^-- >>> ASSERT/,$p' "$FIXTURE" | psql "$DB_URL" -v ON_ERROR_STOP=1

# Leave the dev database the way every other runner expects to find it.
npx supabase db reset --no-seed >/dev/null
