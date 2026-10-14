#!/usr/bin/env bash
# Regenerates packages/contracts/src/generated/api.ts from the FastAPI OpenAPI schema.
# CI runs this and fails if the committed output differs (contracts must never drift).
set -euo pipefail
cd "$(dirname "$0")/.."

(cd services/api && .venv/bin/python scripts/export_openapi.py ../../packages/contracts/openapi.json)
pnpm --filter @campuscart/contracts exec openapi-typescript openapi.json \
  --output src/generated/api.ts --root-types --root-types-no-schema-prefix
