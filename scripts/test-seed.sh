#!/usr/bin/env bash
# scripts/test-seed.sh
# Runs supabase/tests/seed.sql (Task 11) against a freshly-reset local
# database. The file runs as the table-owning superuser (it checks the new-
# user seed trigger's output shape -- profiles/categories values and
# idempotency -- not the RLS boundary; see supabase/tests/rls.sql for that
# suite) and manages its own ON_ERROR_STOP / assertion discipline
# internally, so this runner just resets and invokes it.
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54332/postgres}"

# Same guard as scripts/test-rls.sh and scripts/test-constraints.sh, and for
# the same reason -- parse the actual host libpq would connect to, rather
# than substring-matching the raw URL (see test-rls.sh's comment for why a
# glob is not safe here).
authority="${DB_URL#postgres://}"
authority="${authority#postgresql://}"
authority="${authority%%/*}"
hostport="${authority##*@}"
db_host="${hostport%%:*}"

case "$db_host" in
  127.0.0.1|localhost)
    ;;
  *)
    echo "refusing to run: DB_URL must point at a loopback host (127.0.0.1/localhost)." >&2
    echo "got host: $db_host (from DB_URL: $DB_URL)" >&2
    exit 1
    ;;
esac

npx supabase db reset --no-seed >/dev/null

# `db reset` restarts containers after migrating, and the database can still
# be coming back when the very next psql connects -- observed as "server
# closed the connection unexpectedly" and, once, a half-initialised schema.
# Wait for it rather than racing it.
for _ in $(seq 1 60); do
  psql "$DB_URL" -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
psql "$DB_URL" -f supabase/tests/seed.sql
echo "seed tests passed"
