#!/usr/bin/env bash
# Writes the local env file for a client app from the running local Supabase stack:
#   Next.js apps -> apps/<app>/.env.local (NEXT_PUBLIC_*); student-mobile -> apps/student-mobile/.env (EXPO_PUBLIC_*)
# Usage: bash scripts/web-env.sh [student-web|manager-dashboard|pos-dashboard|student-mobile] [api_base_url]
# Values are the local stack's public URL and anon key (safe for browsers); .env.local is git-ignored.
set -euo pipefail
cd "$(dirname "$0")/.."
app="${1:-student-web}"
api="${2:-http://localhost:8000}"
eval "$(bash scripts/supabase-env.sh)"
if [[ "$app" == "student-mobile" ]]; then
  cat > "apps/$app/.env" <<ENV
EXPO_PUBLIC_API_BASE_URL=$api
EXPO_PUBLIC_SUPABASE_URL=$CAMPUSCART_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY=$TEST_SUPABASE_ANON_KEY
EXPO_PUBLIC_PASSWORD_RESET_URL=http://localhost:3000/reset-password
ENV
  echo "Wrote apps/$app/.env"
  exit 0
fi
cat > "apps/$app/.env.local" <<ENV
NEXT_PUBLIC_API_BASE_URL=$api
NEXT_PUBLIC_SUPABASE_URL=$CAMPUSCART_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$TEST_SUPABASE_ANON_KEY
ENV
echo "Wrote apps/$app/.env.local"
