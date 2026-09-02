# scripts/require-loopback.sh
#
# The loopback guard shared by scripts/test-rls.sh, scripts/test-constraints.sh
# and scripts/check-embeds.sh. It lived, character for character, in the first
# two before check-embeds.sh needed it as well; a third copy of a security
# check is a third place for it to drift, so it is sourced rather than
# re-typed. The comments below are the originals from test-rls.sh, which is
# where this check and its reasoning were written.
#
# Not executable and not a runner: source it, then call `require_loopback`.

# require_loopback <url> <var-name-for-the-error-message>
#
# Refuses to continue unless <url>'s host is loopback.
#
# The RLS suite plays the attacker: it runs unfiltered bulk UPDATE/DELETE
# statements expecting RLS to reduce them to zero affected rows. The URL is
# kept overridable (useful for a non-default local port), but pointed at
# anything reachable over the network that isn't loopback, those statements
# would be genuinely destructive. Refuse rather than guess. The same rule
# binds every other suite here, for the weaker but sufficient reason that
# none of them has any business touching a database or an API that isn't
# this machine's.
#
# Parse the actual host libpq (or curl) would connect to, rather than
# substring-matching the raw URL: a glob like postgres://*@127.0.0.1:* is
# satisfied by any string that merely CONTAINS "@127.0.0.1:" somewhere,
# which a crafted userinfo/query component could contain while the real
# host (the part after the LAST '@' in the authority, before the next ':'
# or '/') is something else entirely.
#
# The scheme is stripped generically (anything up to the first "://"), so
# this handles the postgres:// URLs the SQL suites pass and the http:// URL
# check-embeds.sh passes with one implementation.
require_loopback() {
  local url="$1"
  local var="${2:-URL}"
  local authority hostport db_host

  authority="${url#*://}"
  authority="${authority%%/*}"
  hostport="${authority##*@}"
  # Strip a bracketed IPv6 literal's brackets before splitting on ':', so
  # [::1]:54321 resolves to "::1" rather than to "[" .
  case "$hostport" in
    \[*\]*) db_host="${hostport#[}"; db_host="${db_host%%]*}" ;;
    *)      db_host="${hostport%%:*}" ;;
  esac

  case "$db_host" in
    127.0.0.1|localhost|::1)
      ;;
    *)
      echo "refusing to run: $var must point at a loopback host (127.0.0.1/localhost)." >&2
      echo "got host: $db_host (from $var: $url)" >&2
      exit 1
      ;;
  esac
}
