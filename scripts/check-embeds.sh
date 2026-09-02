#!/usr/bin/env bash
# scripts/check-embeds.sh
#
# Issues every PostgREST *embed* this codebase sends -- verbatim, as an
# ordinary `authenticated` user, over real HTTP -- and fails on anything but
# 200.
#
# Why this exists at all, when the unit suite is green: a nested embed like
# `wallets(name)` is resolved by PostgREST at request time from the schema
# cache, not by anything TypeScript, Vitest or `tsc` can see. When
# 0015_recurring.sql:189 added a SECOND foreign key between `transactions`
# and `wallets` (transactions_currency_matches_wallet, alongside
# transactions_wallet_id_fkey), the unhinted `wallets(name)` in
# /transactions became AMBIGUOUS: PostgREST answered PGRST201 with HTTP 300,
# /transactions broke for every user, and it shipped undetected across three
# tasks with the entire unit suite passing. Two of the embeds below now
# carry an explicit `!transactions_wallet_id_fkey` hint for exactly that
# reason; the ones that do not are correct only for as long as their table
# has exactly one FK to each embedded table. This script's job is to notice
# the day that stops being true.
#
# It is a check against the LOCAL stack only -- see the loopback guard
# below.
set -euo pipefail

# Resolved to an ABSOLUTE path BEFORE the `cd` below (task 8, item 5c). This
# used to be `. "$(dirname "${BASH_SOURCE[0]}")/require-loopback.sh"` further
# down, evaluated AFTER the cd had already changed what that relative path
# meant: invoked from a parent directory as
# `./FlapSpenditure-v2/scripts/check-embeds.sh`, the source died with
# `require-loopback.sh: No such file or directory`. It failed CLOSED --
# `set -euo pipefail` aborts rather than running unguarded -- so it was a
# broken gate, not a security hole, but a gate that only works from one
# directory is a gate people stop running.
#
# scripts/test-rls.sh and scripts/test-constraints.sh source the same guard
# with the same relative expression and are unaffected: neither cds, so
# `dirname "${BASH_SOURCE[0]}"` still names the script's own directory when
# they evaluate it. (Both do pass cwd-relative `-f supabase/tests/*.sql`
# paths to psql, so they still have to be run from the repo root -- but that
# fails loudly at psql, after the loopback guard has already run, which is
# the safe order.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR/.."

API_URL="${API_URL:-http://127.0.0.1:54321}"

# Every embed below is issued as a real HTTP request carrying a real
# `authenticated` JWT. Same guard, same implementation and same reasoning as
# the two SQL suites (scripts/require-loopback.sh): a URL that isn't
# loopback is some other machine's database, and this script has no business
# there.
# shellcheck source=scripts/require-loopback.sh
. "$SCRIPT_DIR/require-loopback.sh"
require_loopback "$API_URL" API_URL

# The floor the controller's Task 7 addendum names: four embeds exist in
# src/ today (recurring_rules x2, transactions x2). Finding MORE is expected
# as the app grows; finding fewer means the extractor below is broken, and a
# check that silently matches nothing is worse than no check -- so that is a
# failure, not a pass.
MIN_EMBEDS="${MIN_EMBEDS:-4}"

if ! command -v node >/dev/null 2>&1; then
  echo "refusing to run: node is required (used to extract the embeds and mint a local JWT)." >&2
  exit 1
fi

status_json="$(npx supabase status -o json 2>/dev/null || true)"
if [ -z "$status_json" ]; then
  echo "could not read \`npx supabase status\` -- is the local stack running (\`npx supabase start\`)?" >&2
  exit 1
fi

# ANON_KEY is the Kong gateway's api key (required on every request); the
# Authorization bearer below is a SEPARATE, freshly minted token whose role
# is `authenticated`, so these queries run under the same RLS and column
# grants a signed-in user gets -- not under `anon` (which has no SELECT
# grant at all and would fail every embed for the wrong reason) and
# emphatically not under `service_role` (which bypasses RLS and would hide a
# grant regression). Both values come from the local stack's own status
# output; nothing is hard-coded here, and none of it is a hosted secret.
read -r ANON_KEY AUTH_JWT <<EOF
$(printf '%s' "$status_json" | node -e '
const crypto = require("crypto");
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const s = JSON.parse(raw);
  if (!s.ANON_KEY || !s.JWT_SECRET) { process.exit(1); }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  // A UUID that belongs to no real user: every query below is expected to
  // come back 200 with an empty array. This check is about whether
  // PostgREST can RESOLVE the embed, not about what rows it returns, and
  // impersonating a seeded user would make the result depend on seed data.
  const payload = b64({
    role: "authenticated",
    aud: "authenticated",
    sub: "00000000-0000-4000-8000-000000000000",
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const sig = crypto.createHmac("sha256", s.JWT_SECRET).update(header + "." + payload).digest("base64url");
  process.stdout.write(s.ANON_KEY + " " + header + "." + payload + "." + sig);
});
')
EOF

if [ -z "${ANON_KEY:-}" ] || [ -z "${AUTH_JWT:-}" ]; then
  echo "could not derive a local anon key / authenticated JWT from \`supabase status\`." >&2
  exit 1
fi

# Extract every `.from("<table>") ... .select("<cols>")` pair in src/ whose
# select string contains a `(` -- i.e. a nested embed. Test files are
# excluded: their select strings are fixtures for mocked clients, not
# queries any user ever sends.
#
# The gap between `.from(` and `.select(` is matched lazily and may not
# contain another `.from(`, so a `.from()` with no `.select()` cannot reach
# forward and pair itself with the next query's select string.
#
# KNOWN LIMIT (task 8, item 5d): the select string must be a LITERAL at the
# call site. Single quotes, double quotes, backtick template literals and
# multi-line select strings all work -- a reviewer's probe adding four new
# syntactic forms found all 7 embeds -- but a select hoisted into a constant
# (`const COLS = "id, wallets(name)"; ... .select(COLS)`) is silently
# skipped, and an embed hoisted that way would leave this gate with no
# signal at all. No such pattern exists in src/ today; the grep after the
# extractor warns if one appears.
embeds_tsv="$(node -e '
const fs = require("fs");
const path = require("path");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
  }
})("src");

const RE = new RegExp(
  "\\.from\\(\\s*([\"'\''`])([^\"'\''`]+)\\1\\s*\\)" +
    "((?:(?!\\.from\\()[\\s\\S])*?)" +
    "\\.select\\(\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|`((?:[^`\\\\]|\\\\.)*)`|'\''((?:[^'\''\\\\]|\\\\.)*)'\'')",
  "g",
);

for (const file of files.sort()) {
  const src = fs.readFileSync(file, "utf8");
  let m;
  while ((m = RE.exec(src)) !== null) {
    const select = m[4] ?? m[5] ?? m[6] ?? "";
    if (!select.includes("(")) continue;
    // Line of the select STRING, not of the `.from(` that opened the chain.
    const at = m.index + m[0].length - select.length;
    const line = src.slice(0, at).split("\n").length;
    process.stdout.write([file + ":" + line, m[2], select.replace(/\s+/g, " ").trim()].join("\t") + "\n");
  }
}
')"

if [ -z "$embeds_tsv" ]; then
  echo "FAIL: found no PostgREST embeds in src/ at all -- the extractor is broken." >&2
  exit 1
fi

# The secondary check for the KNOWN LIMIT above: a `.select(` whose argument
# is an IDENTIFIER rather than a string literal. Such a call is invisible to
# the extractor, so if its select string happens to contain an embed, that
# embed silently leaves this gate.
#
# A WARNING, not a failure: a hoisted select with no `(` in it is perfectly
# fine and there is no way to tell the two apart without evaluating the
# constant. Warning keeps the signal without failing a build over a legal
# pattern -- the point is that the day someone writes one, this says so.
#
# Deliberately conservative. `[[:space:]]` not `\s` (BSD grep's ERE does not
# reliably support the latter), and no line-spanning: `.select(` followed by
# a newline is the multi-line-literal form the extractor already handles, so
# requiring the identifier on the SAME line is what keeps this from crying
# wolf on every multi-line select in src/.
hoisted_selects="$(grep -rnE '\.select\([[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*' \
  --include='*.ts' --include='*.tsx' src 2>/dev/null | grep -v '\.test\.' || true)"
if [ -n "$hoisted_selects" ]; then
  echo "WARNING: .select(<identifier>) found -- the extractor only reads LITERAL select strings," >&2
  echo "         so any embed inside these is NOT checked by this script:" >&2
  printf '%s\n' "$hoisted_selects" | sed 's/^/           /' >&2
fi

found=0
failed=0
while IFS=$'\t' read -r where table select_str; do
  [ -n "$where" ] || continue
  found=$((found + 1))
  body_file="$(mktemp)"
  code="$(curl -sS -o "$body_file" -w '%{http_code}' -G "$API_URL/rest/v1/$table" \
    --data-urlencode "select=$select_str" \
    --data-urlencode "limit=1" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $AUTH_JWT" || echo "000")"
  if [ "$code" = "200" ]; then
    printf '  ok   %s  %s  [%s]\n' "$code" "$where" "$table"
  else
    failed=$((failed + 1))
    printf '  FAIL %s  %s  [%s]\n' "$code" "$where" "$table"
    printf '       select: %s\n' "$select_str"
    printf '       body:   %s\n' "$(head -c 600 "$body_file")"
  fi
  rm -f "$body_file"
done <<EOF
$embeds_tsv
EOF

echo "checked $found embed(s) against $API_URL as role=authenticated"

if [ "$found" -lt "$MIN_EMBEDS" ]; then
  echo "FAIL: found only $found embed(s), expected at least $MIN_EMBEDS -- the extractor is broken." >&2
  exit 1
fi

if [ "$failed" -gt 0 ]; then
  echo "FAIL: $failed embed(s) did not return 200 (HTTP 300 / PGRST201 means an ambiguous embed needing an explicit !fkey hint)." >&2
  exit 1
fi

echo "embed checks passed"
