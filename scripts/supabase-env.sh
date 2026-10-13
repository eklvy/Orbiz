#!/usr/bin/env bash
# Prints `export` lines for the API + integration tests, derived from the running local
# Supabase stack. Usage:  eval "$(bash scripts/supabase-env.sh)"
# Local stack values only — these are the CLI's well-known development keys, never real ones.
set -euo pipefail
cd "$(dirname "$0")/.."

status="$(pnpm exec supabase status -o env 2>/dev/null)" || {
  echo "Local Supabase is not running (pnpm db:start)" >&2
  exit 1
}
get() { printf '%s\n' "$status" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -1; }

api_url="$(get API_URL)"
mail_url="$(get MAILPIT_URL)"
[[ -n "$mail_url" ]] || mail_url="$(get INBUCKET_URL)"

echo "export CAMPUSCART_SUPABASE_URL='${api_url}'"
echo "export CAMPUSCART_DATABASE_URL='$(get DB_URL)'"
echo "export TEST_SUPABASE_ANON_KEY='$(get ANON_KEY)'"
echo "export TEST_MAILPIT_URL='${mail_url}'"
