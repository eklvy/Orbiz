# CampusCart — Implementation Status

Status vocabulary: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `INCOMPLETE` · `COMPLETE`.
A phase is `COMPLETE` only when its acceptance criteria were verified by commands actually run.

Last updated: 2026-10-13 (Phase 0).

## Phase overview

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository inspection, architecture, scaffolding, tooling | **COMPLETE** |
| 1 | Database, authentication, authorization, RLS | NOT STARTED |
| 2 | Core backend, ordering, inventory, real-time events | NOT STARTED |
| 3 | Student website + student mobile app | NOT STARTED |
| 4 | Manager dashboard + POS/kitchen dashboard | NOT STARTED |
| 5 | Payments, wallets, group orders, notifications, loyalty, budgets, specials/polls/reviews | NOT STARTED |
| 6A | RL environments, reward design, baselines | NOT STARTED |
| 6B | RL training, evaluation, reproducibility, comparisons | NOT STARTED |
| 6C | Live RL integration, fallbacks, RL Insights | NOT STARTED |
| 7 | BiteBot, Surprise Meal, demand forecasting | NOT STARTED |
| 8 | End-to-end validation, security, performance, deployment readiness | NOT STARTED |

Phases run strictly in order. Each one starts only on the explicit instruction `Continue to Phase N`.

---

## Phase 0 — COMPLETE

### Inspection findings

- `Orbiz_Anti/` was empty (no files, not a git repo). The project is built **from scratch**. At the user's instruction, no code or content from other folders is reused.
- Requirements read from `~/Documents/Projects/CampusCart_Team_Orbiz_Report.docx` (same content as the PDF). The feature map and conflicts are in [REQUIREMENTS.md](REQUIREMENTS.md).
- Toolchain found: Node 26.7, npm 11.19, Python 3.13.9, Docker 29.7, git 2.54, psql 16.15.
  Missing: **pnpm** (installed globally, 12.11.2), **Supabase CLI** (needed in Phase 1), uv/poetry (not needed; venv + pip used).

### Delivered

- pnpm workspace (`apps/*`, `packages/*`), pinned `packageManager`, strict shared tsconfig presets, Prettier, EditorConfig, `.gitignore`, `.nvmrc`.
- `packages/contracts`: shared API error envelope type and guard, plus 3 Vitest tests.
- Three Next.js 16 app shells (student-web :3000, manager-dashboard :3001, pos-dashboard :3002). Each shows an honest "scaffolding only" page and builds in production mode.
- `apps/student-mobile`: README only. The Expo scaffold is deferred to Phase 3 (reason documented there).
- `services/api` FastAPI skeleton: validated settings, `/api/v1/health`, JSON structured logging, `X-Request-ID` propagation, consistent error envelope, OpenAPI disabled in production. ruff + mypy `--strict` + 5 pytest tests.
- `supabase/`, `ml/`, `services/intelligence/` placeholders with READMEs describing what arrives in which phase.
- `.env.example` files (root master list plus one per app/service) with placeholders only.
- `scripts/verify.sh` and GitHub Actions CI running the same checks.
- Docs: `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/REQUIREMENTS.md`, this file.

### Verification (actually run, 2026-10-13)

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` | OK (379 packages; one build script allow-listed: `unrs-resolver`) |
| Formatting | `pnpm format:check` | All files pass |
| Typecheck | `pnpm typecheck` | 4/4 packages pass |
| Lint | `pnpm lint` (`--max-warnings=0`) | 3/3 apps pass |
| TS tests | `pnpm test` | 3/3 Vitest tests pass |
| Builds | `pnpm build` | 3/3 Next.js production builds succeed |
| Python lint/format | `ruff check .` / `ruff format --check .` | pass |
| Python types | `mypy` (strict) | no issues in 13 files |
| Python tests | `pytest -q` | 5/5 pass |
| Live API smoke | `uvicorn app.main:app` + `curl /api/v1/health` | 200, JSON body, `X-Request-ID` header, JSON access log line |
| Full script | `bash scripts/verify.sh` | "All checks passed." |
| Secret scan | grep of all files git would track for live keys / JWTs / private keys | no secrets found |

A bug was found and fixed during verification: `/health` read the process-global settings instead of the settings
the app instance was created with. Fixed via `app.state.settings` and the `app_settings` dependency, and covered by a test.

**Not verified:** the GitHub Actions workflow has not run, because there is no remote repository and nothing has been committed yet.

### Acceptance criteria

- [x] The repository has a documented architecture (`docs/ARCHITECTURE.md`)
- [x] The authorized phase sequence is recorded (this file, `AGENTS.md`)
- [x] The status document tracks every phase
- [x] The initial workspace is configured and verified
- [x] Environment templates contain no real secrets
- [x] Setup and verification instructions are documented (`README.md`)
- [x] Unresolved decisions and prerequisites are listed (below, and `docs/REQUIREMENTS.md` §2)
- [x] Verification results are reported honestly (table above)

---

## Prerequisites and blockers for upcoming phases

| Needed for | Item | Status |
|---|---|---|
| Phase 1 | Supabase CLI (will be added as a pinned npm devDependency) + Docker running | Docker present; CLI to install |
| Phase 1 | Decisions D-4 (guest mode), D-10 (login identifier), D-11 (email domain) | OPEN, defaults documented |
| Phase 1 | Real outlet list (D-14) for non-dev seeds | OPEN (dev seeds will be fictional) |
| Phase 2 | Decision D-2 (seat/crowd data source) | OPEN, default documented |
| Phase 3 | Expo account / device or simulator for mobile testing | Not yet checked |
| Phase 5 | Razorpay **test-mode** key ID, key secret, webhook secret | Not provided |
| Phase 5 | Expo push access token; decisions D-6 (signup bonus), D-15 (loyalty policy) | Not provided / OPEN |
| Phase 7 | LLM provider choice for BiteBot (optional; must work without one) | Not decided |
| Staging/prod | Supabase projects, hosting targets, domain | Not provided |

## Known limitations (Phase 0)

- Only `/api/v1/health` exists. There is no database, auth, or domain logic yet, by design.
- App pages are placeholders that say so explicitly.
- pnpm was installed globally with `npm i -g pnpm@12.11.2`, since Node 26 doesn't ship corepack.
