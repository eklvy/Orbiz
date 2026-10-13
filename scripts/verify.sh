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

step "pytest (services/api)"
(cd "$API" && .venv/bin/pytest -q)

printf '\nAll checks passed.\n'
