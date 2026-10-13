# CampusCart — Implementation Status

Status vocabulary: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `INCOMPLETE` · `COMPLETE`.
A phase is `COMPLETE` only when its acceptance criteria were verified by commands actually run.

Last updated: 2026-10-13 (Phase 1).

## Phase overview

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository inspection, architecture, scaffolding, tooling | **COMPLETE** |
| 1 | Database, authentication, authorization, RLS | **COMPLETE** |
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

**CI:** after the push to `eklvy/Orbiz`, the first GitHub Actions run passed (verified via the GitHub API at the start of Phase 1).

**Phase 0 defect found later:** `services/api/campuscart_api.egg-info/` (a pip build artifact) was committed. It was removed from git
and added to `.gitignore` in Phase 1.

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

## Phase 1 — COMPLETE

### Decisions applied (user gave no answers, so the documented defaults were used)

- D-4: no guest ordering. Signed-out visitors can only read active outlets.
- D-10: sign in with email + password via Supabase Auth. `roll_number` is stored on the profile and unique case-insensitively.
- D-11: email-domain allow-list implemented. It's empty locally, which means any domain is allowed.
- D-14: dev seeds are fictional (`Dev Sample North Café`, etc.) and local/test only.

### Delivered

**Database** (`supabase/migrations/`, Postgres 17 via Supabase CLI 2.120.0):

| Migration | Contents |
|---|---|
| `20261013120000_foundation.sql` | `private` schema (not exposed via the Data API), `set_updated_at` trigger, enums `customer_type`, `platform_role`, `outlet_role` |
| `20261013120100_identity.sql` | `profiles` (constraints, unique roll number), `user_roles`, `private.allowed_email_domains`, `private.is_admin()`, signup trigger `private.handle_new_user()`, column-level grants, RLS |
| `20261013120200_outlets.sql` | `outlets`, `outlet_staff` (one role per user per outlet), `private.is_outlet_staff/manager()`, admin-only-field trigger, RLS |
| `20261013120300_audit_logs.sql` | append-only `audit_logs` + trigger on outlets / outlet_staff / user_roles, RLS |

**Seeds:** `supabase/seeds/01_dev_identity.sql` has 7 fictional accounts (admin, two managers, kitchen staff, two students,
faculty) and 3 outlets, one of them inactive. The credentials are in the file header.

**API** (`services/api`):
- `app/core/auth.py`: Supabase JWT verification (JWKS ES256/RS256, optional HS256), `current_principal` dependency
- `app/core/db.py`: psycopg pool; `user_transaction()` runs queries as the caller under RLS
- `GET /api/v1/me`: profile, platform roles, outlet memberships. `PATCH /api/v1/me`: editable fields only, with extras rejected (422)
- `GET /api/v1/health/ready`: database readiness (503 envelope when unavailable)
- New error code `service_unavailable` (Python and `@campuscart/contracts`)
- Settings: `CAMPUSCART_SUPABASE_URL`, `CAMPUSCART_DATABASE_URL`, optional `CAMPUSCART_SUPABASE_JWT_SECRET`,
  `CAMPUSCART_JWT_AUDIENCE`, and pool sizes. Staging and production refuse to start without the Supabase URL and DB URL.

**Tooling:** `pnpm db:start|stop|reset|test|status`, `scripts/supabase-env.sh`, `verify.sh` now runs the DB reset, pgTAP and
integration tests when the stack is up (and says SKIPPED otherwise), and a new CI `database` job.

### Verification (actually run, 2026-10-13)

| Check | Result |
|---|---|
| `supabase start` (fresh) | All 4 migrations and the seed applied with no errors |
| `supabase db reset` (inside `verify.sh`) | Clean re-apply from scratch |
| `supabase test db` (pgTAP) | **56/56 pass** across 4 files: schema invariants (9), profiles (16), outlets/staff/roles (22), audit (9) |
| Mutation check | Disabling RLS on `profiles` and loosening the staff-insert policy made **5 tests fail** across 3 files; after a reset everything passed again. This shows the tests detect real authorization regressions |
| `pytest -m "not integration"` | 25/25 pass (token verification: valid ES256/HS256; rejects expired, wrong aud/iss, missing claims, foreign key, anon/service-role, `alg=none`, HS256 without a secret, tampering, garbage) |
| `pytest -m integration` (real GoTrue + Postgres) | **10/10 pass**: readiness; signup creates profile; profile edit allow-list; duplicate roll number rejected; seeded manager and admin roles; real-token verification + tampered/anon-key rejection; API DB session runs as `authenticated` under RLS and resets after the transaction; logout revokes refresh token; password-recovery email delivered to local Mailpit |
| Local token algorithm | User tokens are ES256 with JWKS (EC key), so the asymmetric path is the one exercised |
| Live API smoke (`uvicorn` + `curl`) | `/health/ready` gives 200; `/me` with a real kitchen-staff token returns the outlet role; no token gives the 401 envelope; the token never appears in logs |
| ruff / ruff format / mypy `--strict` | Pass (23 files) |
| `bash scripts/verify.sh` | "All checks passed." (all JS checks, builds, Python checks, DB reset, pgTAP, integration) |

**Not verified:** the new CI `database` job hasn't run on GitHub, because Phase 1 hasn't been pushed.

### Acceptance criteria

- [x] Core migrations apply successfully (fresh start + reset)
- [x] Authentication works in the configured environment (signup, password login, logout/refresh revocation, password recovery email, against local Supabase Auth)
- [x] Core RLS policies are tested (56 pgTAP assertions + mutation check)
- [x] Unauthorized access is rejected (cross-user profiles, cross-outlet edits, privilege escalation, forged `granted_by`, audit tampering, anon access, invalid tokens)

### Known limitations (Phase 1)

- An access token remains valid until it expires (≤ 1 h) after logout; only the refresh token is revoked.
- A failed signup due to the domain allow-list or an invalid roll number surfaces from Supabase Auth as a generic
  "Database error saving new user". Phase 3 clients must validate first. A `before-user-created` auth hook could give
  precise errors later.
- Staff and admin accounts have `customer_type = student` by default (the field only matters for customers). Cosmetic.
- Signup metadata is user-controlled, so anyone can register as `faculty`. That's harmless today (same permissions) but must be
  revisited if faculty ever get different prices or privileges.
- There's no protection against removing the last admin. Admin management UIs arrive in later phases.
- Staff lookup by email (for managers adding kitchen staff) is not implemented. It needs a server endpoint (Phase 4).
- Docker Desktop crashed once during the first image pull (host disk briefly full). It recovered after a restart. This is environmental and not a code issue.

---

## Prerequisites and blockers for upcoming phases

| Needed for | Item | Status |
|---|---|---|
| Phase 1 | Supabase CLI + Docker | Done (CLI 2.120.0 pinned; Docker Desktop running) |
| Any | Decisions D-4, D-10, D-11 | Defaults implemented; can be changed later (D-11: insert real domain(s) into `private.allowed_email_domains`) |
| Pilot | Real outlet list and menus (D-14) | OPEN (dev seeds are fictional) |
| Phase 2 | Decision D-2 (seat/crowd data source) | OPEN, default documented |
| Phase 3 | Expo account / device or simulator for mobile testing | Not yet checked |
| Phase 5 | Razorpay **test-mode** key ID, key secret, webhook secret | Not provided |
| Phase 5 | Expo push access token; decisions D-6 (signup bonus), D-15 (loyalty policy) | Not provided / OPEN |
| Phase 7 | LLM provider choice for BiteBot (optional; must work without one) | Not decided |
| Staging/prod | Supabase projects, hosting targets, domain | Not provided |

## Known limitations (Phase 0)

- App pages are placeholders that say so explicitly.
- pnpm was installed globally with `npm i -g pnpm@12.11.2`, since Node 26 doesn't ship corepack.
