# CampusCart — Architecture

Status: **Phase 0 baseline.** Sections marked _(proposed)_ are design intent. They are finalised in the
phase that implements them and updated here when that happens.

Requirement sources: `CampusCart_Team_Orbiz_Report.pdf/.docx` (Team Orbiz, Aug 2026) and the master
build prompt. Conflicts between the two are tracked in [REQUIREMENTS.md](REQUIREMENTS.md).

---

## 1. Problem and goal

Students get about 10 minutes between classes and lose most of it queuing at canteens. CampusCart
replaces the physical queue with pre-ordering, scheduled pickup slots, and a live digital token.
Managers and kitchen staff run the operation from real-time dashboards. Success means a student can
order before leaving class, arrive at the chosen slot, and collect food without queuing.

## 2. System context

```
 ┌───────────────┐ ┌───────────────┐ ┌────────────────────┐ ┌────────────────────┐
 │ Student web   │ │ Student mobile│ │ Manager dashboard  │ │ POS / kitchen      │
 │ Next.js :3000 │ │ Expo (RN)     │ │ Next.js :3001      │ │ Next.js :3002      │
 └──────┬────────┘ └──────┬────────┘ └─────────┬──────────┘ └─────────┬──────────┘
        │  HTTPS + Supabase JWT (all business mutations)               │
        ├────────────────────────┬─────────────────────────────────────┤
        │                        ▼                                     │
        │            ┌──────────────────────────┐                      │
        │            │  CampusCart API (FastAPI)│── payments ──► Razorpay (Phase 5)
        │            │  services/api            │── push ──────► Expo Push (Phase 5)
        │            └──────┬──────────┬────────┘                      │
        │                   │ SQL (tx) │ bounded inference (6C/7)      │
        │                   ▼          ▼                               │
        │   ┌────────────────────┐  ┌───────────────────────────┐     │
        │   │ Supabase Postgres  │  │ intelligence (models)     │     │
        │   │ + Auth + RLS       │  │ trained offline in ml/    │     │
        │   └────────┬───────────┘  └───────────────────────────┘     │
        │            │ Realtime (RLS-filtered change events)          │
        └────────────┴────────────────────────────────────────────────┘
          clients sign in with Supabase Auth and subscribe to Realtime directly
```

## 3. Repository layout

```
apps/
  student-web/          Next.js App Router, student website             (Phase 3)
  student-mobile/       Expo app — README only until Phase 3            (Phase 3)
  manager-dashboard/    Next.js, outlet-scoped manager console          (Phase 4)
  pos-dashboard/        Next.js, kitchen queue / counter                 (Phase 4)
packages/
  config/               shared tsconfig presets
  contracts/            shared API types (error envelope now; OpenAPI-generated from Phase 2)
services/
  api/                  FastAPI backend — the only writer of business state
  intelligence/         inference boundary — README only until Phase 6C
supabase/
  migrations/ seeds/ tests/   schema + RLS source of truth (Supabase CLI layout)
ml/                     offline training/evaluation — README only until Phase 6A
docs/                   this file, status, requirements traceability
scripts/verify.sh       runs every available check
tests/                  cross-app end-to-end tests (Playwright, from Phase 3)
```

How this differs from the layout suggested in the master prompt, and why:

- `database/` became `supabase/`, because the Supabase CLI expects `supabase/migrations` and `supabase/tests`.
- `packages/ui`, `packages/api-client` and `packages/validation` are not created yet. They will be added
  when a second consumer actually needs shared code, to avoid empty abstractions. Shared validation
  rules live in the backend (authoritative); clients get types from `contracts`.
- `docker-compose.yml` is not added. The Supabase CLI runs Postgres, Auth, Realtime and Storage in Docker
  itself (`supabase start`). Compose will be added only if a service the CLI doesn't cover appears.

## 4. Service responsibilities and boundaries

| Component | Owns | Must not |
|---|---|---|
| Clients (4) | UI state, carts in progress, presentation | Compute authoritative prices or totals, decide availability, mark payments successful, change order status directly |
| API (`services/api`) | All business mutations: orders, stock, slots, status transitions, payments, refunds, wallet/loyalty ledgers, group orders, polls, reviews, RL decision calls | Trust client-supplied amounts, roles or user IDs |
| Postgres (Supabase) | Data, constraints, RLS, atomic functions where a lock-heavy step is simpler in SQL | Contain secrets or raw card data |
| Supabase Auth | Identity, sessions, JWT issuing | Hold roles. Roles live in our tables and are checked server-side |
| Supabase Realtime | Fan-out of committed changes to authorised subscribers | Be treated as proof of a mutation. The database is the source of truth |
| Intelligence | Recommendations within a valid action set supplied by the API | Override stock, capacity, payment, permission or state-machine rules |
| `ml/` | Offline training and evaluation | Run on the request path or at app startup |

### Write path _(proposed, finalised in Phases 1–2)_

1. A client calls the API with its Supabase access token (`Authorization: Bearer …`).
2. The API verifies the JWT (signature via the project JWKS, `aud`, `exp`) and loads roles and outlet scope from the DB.
3. User-scoped operations run in a transaction where the DB session adopts the caller's identity
   (`set local role authenticated` plus `request.jwt.claims`), so **RLS applies to the API too**.
   It's defence in depth, not a replacement for explicit authorization checks in services.
4. Privileged system operations (payment webhooks, reservation expiry, RL logging) use a separate,
   narrowly-scoped DB role. They never use the service-role key in a client.

### Read path

- Public outlet/menu data: clients may read directly via Supabase with the anon key, under RLS policies that expose only intentionally public columns. Alternatively they go through the API (decided per endpoint in Phase 2).
- Private data (orders, wallet) goes through the API, or Supabase reads under RLS.
- Live updates: clients subscribe to Realtime on tables or channels that RLS restricts to rows they may see (own orders; staff: own outlet).

## 5. Identity and authorization model _(proposed, Phase 1)_

- **Global roles:** `student`, `admin`. Faculty are customers like students. The report mentions a Faculty login, so `customer_type` is kept as a profile attribute rather than a role ([REQUIREMENTS.md](REQUIREMENTS.md) D-5).
- **Outlet-scoped roles** via `outlet_staff(user_id, outlet_id, role)`, where role is `manager` or `kitchen_staff`. One user can manage outlet A and be kitchen staff at outlet B.
- Authorization helpers are SQL functions used by RLS (`is_outlet_manager(outlet_id)`, `is_outlet_staff(outlet_id)`, `is_admin()`), mirrored by Python service checks.
- The browser never supplies a role. Route guards in the UI are only UX; the API and RLS enforce access.

## 6. Database and migration workflow _(proposed, Phase 1)_

- Supabase CLI (`supabase` npm devDependency, pinned) manages the local stack and migrations.
- `supabase migration new <name>` creates the migration; SQL is hand-written and reviewed. **Migrations are the only source of schema truth.** The API does not use ORM auto-migration (no Alembic) to avoid two competing schema owners.
- Local: `supabase start`, `supabase db reset` (applies all migrations and seeds), `supabase test db` (pgTAP).
- Conventions: `timestamptz` everywhere; `created_at`/`updated_at`; money as `integer` paise with `CHECK (>= 0)`; explicit FKs with chosen `ON DELETE`; indexes for every FK and hot filter; RLS enabled on every table in `public`.
- Remote environments get migrations via `supabase db push` from CI. Never via dashboard edits.
- Domain tables are added in the phase that implements them, not all in Phase 1.

## 7. API contracts

- REST under `/api/v1`, documented by FastAPI's OpenAPI (`/openapi.json`, disabled in production).
- **Error envelope** (implemented in Phase 0): `{"error": {"code", "message", "request_id", "details?"}}`, with
  `code` from a fixed set (`validation_error`, `unauthenticated`, `forbidden`, `not_found`, `conflict`,
  `rate_limited`, `internal_error`). Python: `app/core/errors.py`. TypeScript: `packages/contracts/src/errors.ts`.
- **Request IDs:** every response carries `X-Request-ID`. A safe caller-supplied value is echoed; otherwise a new one is generated. It is included in every structured log line.
- **Type sharing (from Phase 2):** a script exports `openapi.json` from the app and runs `openapi-typescript` into `packages/contracts/src/generated/`. CI fails if the generated file is stale. All four clients import types from `@campuscart/contracts`, so no client re-declares backend types.
- Retryable mutations (order create, payment initiation, refunds) accept an `Idempotency-Key` header (Phase 2/5).
- List endpoints are cursor-paginated.

## 8. Order lifecycle _(proposed, finalised in Phase 2)_

```
PAYMENT_PENDING ─pay verified─► PLACED ─staff─► CONFIRMED ─staff─► PREPARING ─staff─► READY_FOR_PICKUP ─token verified─► COMPLETED
      │ expiry/cancel              │ student/staff  │ staff          │ staff (exception)
      ▼                            ▼                ▼                ▼
  CANCELLED                    CANCELLED/REJECTED → REFUND_PENDING → REFUNDED (when paid)
```

The full transition table records, for each transition: from-state, to-state, allowed actor, required payment state, side effects (stock/slot release, refund creation, notification), the event written to `order_events`, and reversibility. Stock and slot reservations are taken at order creation in the same transaction as the order. They expire if payment doesn't complete within a configured TTL, and expiry can never touch a paid order.

## 9. Real-time

- Supabase Realtime (Postgres changes on RLS-protected tables, or broadcast from a transactional outbox for derived events). The choice is made in Phase 2 after measuring.
- Client rules: subscribe only to authorised scopes; unsubscribe on unmount; refetch authoritative state on (re)connect; dedupe by event ID or version; never treat an event as success of the client's own mutation.
- Target: p95 under 2 s from commit to visibility on a subscribed client. **It is measured, not assumed**, in Phases 2 and 8.

## 10. Intelligence _(proposed, Phases 6–7)_

- **Kitchen Dispatcher (PPO):** Gymnasium env + Stable-Baselines3 PPO with action masking. Baselines: FIFO, SPT, EDD, and a rule-based policy.
- **Slot Nudger (contextual bandit, Thompson sampling):** acts only over slots the API marks valid at that moment. Includes a no-recommendation action. Baselines: random-valid, least-loaded, rule-based.
- **Live integration (6C):** feature flag per model (`off`, `shadow`, `live`), inference timeout, action validation, deterministic fallback, and a decision log for every call. A model can't be `live` without a recorded passing evaluation.
- **Forecasting / BiteBot / Surprise Meal (7):** grounded only in backend data. BiteBot must degrade gracefully with no LLM provider configured. Recommendations are revalidated at checkout.
- Out of scope: campus navigation and the RL Campus Navigator.

## 11. Environments

| Env | `CAMPUSCART_ENVIRONMENT` | Database | Payments | Notes |
|---|---|---|---|---|
| Local | `local` | `supabase start` (Docker) | Razorpay test mode or none | Dev seeds allowed |
| Automated test | `test` | ephemeral local Supabase in CI | provider stubbed at the HTTP boundary, signatures computed with test secrets | Never real credentials |
| Staging | `staging` | separate Supabase project | Razorpay test mode | Mirrors prod config |
| Production | `production` | separate Supabase project | Razorpay live | OpenAPI docs disabled; no seeds |

Secrets are read from the environment only. `.env.example` files contain placeholders. Browser and mobile bundles receive only `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` values, which must be safe to publish (URLs, anon key).

## 12. Testing conventions

| Layer | Tool | Location |
|---|---|---|
| TS unit | Vitest | `*.test.ts` next to source |
| Python unit/integration | pytest | `services/api/tests/` (integration tests marked `@pytest.mark.integration`, need local Supabase) |
| DB constraints & RLS | pgTAP | `supabase/tests/` |
| Browser E2E | Playwright | `tests/e2e/` (Phase 3+) |
| RL/ML | pytest + seeded eval scripts | `ml/**/tests/` |

Every unauthorized-access path gets a negative test. Tests never disable RLS or bypass auth. `scripts/verify.sh` runs everything available, and CI (`.github/workflows/ci.yml`) runs the same checks.

## 13. Observability

The API logs structured JSON (`app/core/logging.py`) with a `request_id` and duration on every request. Later phases add order-creation latency, Realtime propagation, RL inference latency and fallback-rate metrics. Logs never contain secrets, tokens, or payment credentials.

## 14. Toolchain decisions (Phase 0)

| Decision | Choice | Reason |
|---|---|---|
| Package manager | pnpm 12 workspaces (`packageManager` pinned) | Required by prompt. Build scripts are allow-listed (`allowBuilds`) |
| TypeScript | 5.9 (not 7.x) | TS 7 (native compiler) is new; Next.js/ESLint tooling is validated against 5.x. Revisit later |
| Web framework | Next.js 16, React 19, Tailwind 4 | Current stable |
| ESLint | 9.x flat config + `eslint-config-next` | ESLint 10 plugins (react, import) were not yet verified compatible |
| Python | 3.12+ (3.13 locally/CI), FastAPI, pydantic-settings, ruff, mypy `--strict`, pytest, httpx2 | Starlette deprecates `httpx` in its test client in favour of `httpx2` |
| Node | `.nvmrc` = 22 (LTS) for CI; developed on Node 26 | |
