# CampusCart

Pre-order campus canteen food, pick a pickup slot, and collect it with a digital token instead of
standing in a queue. Built by Team Orbiz for The NorthCap University.

**Status:** Phase 0 (scaffolding) complete. No ordering features exist yet. See
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

| Interface | Path | Dev URL |
|---|---|---|
| Student website | `apps/student-web` | http://localhost:3000 |
| Manager dashboard | `apps/manager-dashboard` | http://localhost:3001 |
| POS / kitchen dashboard | `apps/pos-dashboard` | http://localhost:3002 |
| Student mobile app | `apps/student-mobile` | Phase 3 |
| API (FastAPI) | `services/api` | http://localhost:8000 (`/docs` for OpenAPI) |

## Prerequisites

- Node.js ≥ 22.12 (`.nvmrc` pins 22 for CI)
- pnpm 12: `npm install -g pnpm@12.11.2` (or `corepack enable` on Node versions that ship corepack)
- Python ≥ 3.12
- Docker (needed from Phase 1 for the local Supabase stack)

## Setup

```bash
pnpm install

cd services/api
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env        # placeholders; adjust if needed
```

Each app has its own `.env.example`. Copy it to `.env.local` in that app when the app starts reading
those values (Phase 3/4). The root [`.env.example`](.env.example) lists every variable and the phase that introduces it.

## Run

```bash
pnpm dev:student-web        # :3000
pnpm dev:manager            # :3001
pnpm dev:pos                # :3002

cd services/api && .venv/bin/uvicorn app.main:app --reload --port 8000
curl http://localhost:8000/api/v1/health
```

## Verify

```bash
bash scripts/verify.sh
```

This runs Prettier, TypeScript, ESLint, Vitest, Next.js production builds, ruff, mypy (strict) and pytest.
CI (`.github/workflows/ci.yml`) runs the same checks.

## Documentation

- [AGENTS.md](AGENTS.md): working rules, commands, conventions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system design, boundaries, workflows
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md): feature map from the report and open decisions
- [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md): phase status and verification log
