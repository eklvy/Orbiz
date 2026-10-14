#!/usr/bin/env bash
# Fails if regenerating the API contracts would change the files on disk (i.e. they are stale).
set -euo pipefail
cd "$(dirname "$0")/.."

before="$(mktemp -d)"
trap 'rm -rf "$before"' EXIT
cp packages/contracts/openapi.json "$before/openapi.json"
cp packages/contracts/src/generated/api.ts "$before/api.ts"

bash scripts/generate-contracts.sh >/dev/null

if ! diff -q "$before/openapi.json" packages/contracts/openapi.json >/dev/null \
  || ! diff -q "$before/api.ts" packages/contracts/src/generated/api.ts >/dev/null; then
  echo "API contracts were stale and have been regenerated; review and commit packages/contracts." >&2
  exit 1
fi
echo "API contracts are up to date."
