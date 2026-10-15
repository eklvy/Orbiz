#!/usr/bin/env bash
# Runs every check available in the current phase. Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$1"; }

step "Prettier (TS/JSON/config)"
pnpm format:check

step "TypeScript typecheck"
pnpm typecheck

step "ESLint"
pnpm lint

step "Vitest"
pnpm test

step "Next.js production builds"
NEXT_TELEMETRY_DISABLED=1 pnpm build

step "Student mobile: iOS + Android JS bundles (Hermes)"
pnpm --filter @campuscart/student-mobile export:native >/dev/null && echo "iOS and Android bundles built."

API=services/api
PY="$API/.venv/bin"
if [[ ! -x "$PY/python" ]]; then
  echo "Missing $API/.venv — run: python3 -m venv $API/.venv && $PY/pip install -e '$API[dev]'" >&2
  exit 1
fi

step "Ruff lint + format check (services/api)"
(cd "$API" && .venv/bin/ruff check . && .venv/bin/ruff format --check .)

step "mypy --strict (services/api)"
(cd "$API" && .venv/bin/mypy)

step "Generated API contracts are up to date"
bash scripts/check-contracts.sh

step "pytest unit tests (services/api)"
(cd "$API" && .venv/bin/pytest -q -m "not integration")

# Database + integration checks need the local Supabase stack (Docker). They are skipped
# with a clear message when it isn't running; CI always runs them.
db_checks=skipped
if env_lines="$(bash scripts/supabase-env.sh 2>/dev/null)"; then
  eval "$env_lines"
  step "Reset local database (migrations + dev seeds)"
  pnpm exec supabase db reset

  step "pgTAP database tests (schema, RLS, privileges)"
  pnpm exec supabase test db

  step "pytest integration tests (real GoTrue + Postgres)"
  (cd "$API" && .venv/bin/pytest -q -m integration)

  step "Student website end-to-end (Playwright, desktop + mobile viewports)"
  bash scripts/web-env.sh student-web http://localhost:8100 >/dev/null
  (cd apps/student-web && pnpm exec playwright test)

  step "Student mobile app end-to-end (React Native Web build, Playwright)"
  bash scripts/web-env.sh student-mobile http://localhost:8100 >/dev/null
  (cd apps/student-mobile && pnpm e2e)

  step "POS / kitchen dashboard end-to-end (Playwright, desktop + tablet)"
  bash scripts/web-env.sh pos-dashboard http://localhost:8100 >/dev/null
  (cd apps/pos-dashboard && pnpm exec playwright test)

  step "Manager dashboard end-to-end (Playwright, desktop + mobile viewports)"
  bash scripts/web-env.sh manager-dashboard http://localhost:8100 >/dev/null
  (cd apps/manager-dashboard && pnpm exec playwright test)
  db_checks=ran
else
  printf '\n==> SKIPPED database + integration checks: local Supabase is not running (pnpm db:start)\n'
fi

if [[ "$db_checks" == ran ]]; then
  printf '\nAll checks passed.\n'
else
  printf '\nAll non-database checks passed. Database checks were SKIPPED (start Supabase to run them).\n'
fi
