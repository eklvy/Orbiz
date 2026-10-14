# CampusCart — Architecture

Status: **Phase 2 complete.** Sections marked _(proposed)_ are design intent. They are finalised in the
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
  contracts/            shared API types generated from OpenAPI (+ error-envelope helpers)
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

### Write path _(auth + RLS adoption implemented in Phase 1; business writes from Phase 2)_

1. A client calls the API with its Supabase access token (`Authorization: Bearer …`).
2. The API verifies the JWT (`app/core/auth.py`): ES256/RS256 signatures via the project JWKS
   (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached 5 min), or HS256 only if a legacy secret is
   configured. It also checks `iss`, `aud`, `exp`/`iat`/`sub`, and requires `role = authenticated`, so anon and
   service keys are rejected. Roles are never read from the token. They're loaded from the DB.
3. User-scoped operations run in `Database.user_transaction()` (`app/core/db.py`). The DB session adopts the
   caller's identity with transaction-local `set_config('role','authenticated')` and `request.jwt.claims`,
   so **RLS applies to the API too**. It's defence in depth, not a replacement for explicit authorization checks in
   services. An integration test proves `current_user = authenticated` inside the transaction and that the pooled
   connection is privileged again afterwards.
   Driver: psycopg 3 async pool, plain parameterised SQL (no ORM), `prepare_threshold=None` so transaction-mode
   poolers work.
4. Privileged system operations (payment webhooks, reservation expiry, RL logging) use a separate,
   narrowly-scoped DB role. They never use the service-role key in a client.

### Read path

- Public outlet/menu data: clients may read directly via Supabase with the anon key, under RLS policies that expose only intentionally public columns. Alternatively they go through the API (decided per endpoint in Phase 2).
- Private data (orders, wallet) goes through the API, or Supabase reads under RLS.
- Live updates: clients subscribe to Realtime on tables or channels that RLS restricts to rows they may see (own orders; staff: own outlet).

## 5. Identity and authorization model _(implemented, Phase 1)_

- **Global roles:** `student`, `admin`. Faculty are customers like students. The report mentions a Faculty login, so `customer_type` is kept as a profile attribute rather than a role ([REQUIREMENTS.md](REQUIREMENTS.md) D-5).
- **Outlet-scoped roles** via `outlet_staff(user_id, outlet_id, role)`, where role is `manager` or `kitchen_staff`. One user can manage outlet A and be kitchen staff at outlet B.
- Authorization helpers are `SECURITY DEFINER` SQL functions in the non-exposed `private` schema
  (`private.is_admin()`, `private.is_outlet_staff(id)`, `private.is_outlet_manager(id)`), used by RLS policies.
  Later phases mirror them in Python service checks.
- **Profiles** are created by a trigger on `auth.users` from signup metadata (`full_name`, `roll_number`, `department`,
  `year_of_study`, `customer_type`). Users may update only `full_name`, `department`, `year_of_study` and `hostel_room`
  (column-level `GRANT`). `roll_number` and `customer_type` are fixed after signup.
- **Email-domain allow-list** (`private.allowed_email_domains`): empty means any domain is allowed (local default, D-11).
  Once populated, signups from other domains are rejected by the trigger.
- **Staff management:** admins assign any outlet role. Managers may add or remove `kitchen_staff` at their own outlet only.
  `granted_by` must equal the acting user. Managers edit their outlet's descriptive fields, but `slug` and `is_active`
  are admin-only (trigger).
- **Audit:** inserts, updates and deletes on `outlets`, `outlet_staff` and `user_roles` are written by trigger to the append-only
  `audit_logs` table. No client or `service_role` may modify it. Admins read all entries; managers read their outlet's.
- **Sessions:** access tokens live 1 h (`jwt_expiry`), and refresh tokens rotate. Logout revokes the refresh token, but an
  already-issued access token stays valid until it expires (stateless verification). This is an accepted trade-off.
- **Auth abuse limits:** Supabase Auth's built-in rate limits (`[auth.rate_limit]` in `supabase/config.toml`).
  Passwords need at least 8 characters with letters and digits.
- The browser never supplies a role. Route guards in the UI are only UX; the API and RLS enforce access.

## 6. Database and migration workflow _(implemented, Phase 1)_

- Supabase CLI (`supabase` npm devDependency, pinned) manages the local stack and migrations.
- `supabase migration new <name>` creates the migration; SQL is hand-written and reviewed. **Migrations are the only source of schema truth.** The API does not use ORM auto-migration (no Alembic) to avoid two competing schema owners.
- Local: `pnpm db:start`, `pnpm db:reset` (applies all migrations and seeds), `pnpm db:test` (pgTAP).
  `eval "$(bash scripts/supabase-env.sh)"` exports the API/test connection settings from the running stack.
- pgTAP tests share `supabase/tests/_helpers.psql` (`tests.authenticate_as(uuid)`, `tests.as_anon()`, fixtures), created and
  rolled back inside each test transaction. Schema invariants are tested too: RLS on every public table, a policy on every
  table, `search_path` pinned on every `SECURITY DEFINER` function, and no client privileges in `private`.
- Seeds (`supabase/seeds/*.sql`) are fictional dev data. They create auth users directly; local and test only.
- Conventions: `timestamptz` everywhere; `created_at`/`updated_at`; money as `integer` paise with `CHECK (>= 0)`; explicit FKs with chosen `ON DELETE`; indexes for every FK and hot filter; RLS enabled on every table in `public`.
- Remote environments get migrations via `supabase db push` from CI. Never via dashboard edits.
- Domain tables are added in the phase that implements them, not all in Phase 1.

## 7. API contracts

- REST under `/api/v1`, documented by FastAPI's OpenAPI (`/openapi.json`, disabled in production).
- **Error envelope** (implemented in Phase 0): `{"error": {"code", "message", "request_id", "details?"}}`, with
  `code` from a fixed set (`validation_error`, `unauthenticated`, `forbidden`, `not_found`, `conflict`,
  `rate_limited`, `internal_error`). Python: `app/core/errors.py`. TypeScript: `packages/contracts/src/errors.ts`.
- **Request IDs:** every response carries `X-Request-ID`. A safe caller-supplied value is echoed; otherwise a new one is generated. It is included in every structured log line.
- **Type sharing (implemented, Phase 2):** `pnpm contracts:generate` (`scripts/generate-contracts.sh`) exports
  `openapi.json` from the app and runs `openapi-typescript` into `packages/contracts/src/generated/api.ts`. Both files
  are committed; `verify.sh` and CI fail if they are stale. Every error status is documented with the shared envelope,
  and a compile-time check in `errors.ts` fails `tsc` if the frontend error-code list drifts from the backend's.
  All four clients import types from `@campuscart/contracts`, so no client re-declares backend types.
- `POST /orders` requires an `Idempotency-Key` header. Payment initiation and refunds will too (Phase 5).
- List endpoints are cursor-paginated. The endpoint catalogue and business error reasons are in [API.md](API.md).

### Business operations in SQL _(Phase 2)_

Multi-row invariants are enforced in `SECURITY DEFINER` functions in the `app` schema. That schema isn't exposed by
PostgREST or GraphQL, so only the API's SQL connection can call them. They run inside the caller's RLS transaction
(`auth.uid()` identifies the actor) and authorise explicitly. Python services validate input, call them, and shape
responses. Failures use SQLSTATE `CC<http>` with a machine-readable reason in `HINT`, which `app/core/db.py`
translates into the error envelope. Lock order everywhere: outlet → inventory rows (by item id) → pickup slot → order.
System-only functions (`confirm_order_payment`, `expire_pending_orders`, `end_expired_breaks`,
`generate_upcoming_slots`) are executable only by `service_role` / `pg_cron`. The API reaches them through
`Database.system_transaction()`, and `private.is_system_caller()` re-checks inside.

## 8. Ordering, stock and pickup _(implemented, Phase 2)_

**State machine.** It's the data in `public.order_status_transitions`: from, to, actor (`student` / `staff` /
`system`), `requires_paid`, `requires_reason`, `requires_pickup_code`, `releases_stock`, `releases_slot` and
`marks_refund_required`. Statuses are lowercase: `payment_pending → placed → confirmed → preparing →
ready_for_pickup → completed`, plus `cancelled` and `rejected`. No transition is reversible. Refunds are tracked in a
separate `refund_status` (`none` / `required` / `refunded`) so an order keeps *why* it ended. The prompt's
`REFUND_PENDING` / `REFUNDED` statuses are represented this way. Every change bumps `orders.version` and appends
to `order_events` (which also serves as status history).

**Order creation** (`app.create_order`, one transaction):
1. Advisory lock on (user, idempotency key), then replay or reject a reused key.
2. Enforce at most 3 unpaid orders per user.
3. Lock the outlet `FOR SHARE` and check it's accepting orders.
4. Aggregate the lines, then for each item in id order: check it belongs to the outlet, is active and not manually sold
   out, then do an atomic conditional decrement `quantity_available >= q` for tracked items.
5. Lock the slot `FOR UPDATE` and check it's active, starts at least the longest prep time from now, and has capacity left.
6. Insert the order, the item snapshots (name, unit price, prep time), stock-ledger rows and a `created` event, then
   clear the cart.

Any failure raises and rolls back everything. `pickup_slots` also has `CHECK (reserved_count <= capacity)`, and
`inventory` has `CHECK (quantity_available >= 0)`, as a last line of defence.

**Reservations.** An order holds stock and its slot place while `payment_pending`, until
`reservation_expires_at` (outlet `reservation_ttl_minutes`, default 10). `pg_cron` runs `app.expire_pending_orders()`
every minute (`FOR UPDATE SKIP LOCKED`, with the WHERE clause re-checked under the lock) and releases both. A paid
order can't be expired, because payment confirmation and expiry lock the same row and each re-checks the status.

**Payment boundary.** `app.confirm_order_payment(order, reference)` is system-only and idempotent per reference. It
refuses expired reservations, sets `paid` / `placed`, and issues the daily per-outlet token (`<prefix>-<n>`, counters
in `private.outlet_token_counters`) and a 6-character pickup code. The code lives in `order_pickup_codes`, readable only
by the owner and never published. Staff complete pickups with `app.verify_pickup`. Wrong attempts are committed and
counted, and 5 lock the code.

**Stock model (D-12).** `menu_items.track_quantity` selects quantity tracking. `stock_status` is derived by triggers:
`sold_out` if manually sold out or tracked at 0; `low` if manually low or tracked at or below the threshold; otherwise
`available`. All stock changes are appended to `inventory_movements` with reason, actor and order.

**Outlet status.** `open` / `on_break` (with `break_until` and a public reason) / `closed`. Only `open` accepts orders.
An elapsed break counts as open immediately, and `pg_cron` flips it back within a minute.

**Wait estimate and crowd level (D-17, D-2).** From real orders only. Active orders due within 60 minutes each take
their longest item's prep time, divided by the outlet's `concurrent_orders`. Crowd level is `low` up to 5 min,
`medium` up to 15, and `high` above that. There are no seat counts and no sensors.

## 9. Real-time

- **Chosen (Phase 2): Supabase Realtime `postgres_changes`** on `orders`, `order_events`, `outlets`,
  `menu_items`, `inventory` and `pickup_slots`, filtered per subscriber by RLS. Every important change is committed
  (with its `order_events` row) before Realtime sees it, so the database stays the source of truth and no outbox is
  needed yet. Not published: `carts` and `cart_items` (Realtime doesn't apply RLS to DELETE events, which would leak
  other users' keys), `order_pickup_codes` and `inventory_movements`.
- Client rules: subscribe only to authorised scopes; unsubscribe on unmount; refetch authoritative state on (re)connect; dedupe by event ID or version; never treat an event as success of the client's own mutation.
- Target: p95 under 2 s from commit to visibility on a subscribed client. **It is measured, not assumed.**
  Phase 2 local measurement (`tests/integration/test_realtime.py`: Supabase CLI 2.120 stack in Docker Desktop on the
  dev Mac, one subscriber, 30 sequential kitchen transitions): request→event p50 532 ms, **p95 543 ms**;
  commit→event p95 539 ms. The steady ~0.5 s looks like Realtime's change-polling interval, not network time.
  Load and hosted-environment measurements come in Phase 8.

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
| DB driver (Phase 1) | psycopg 3 async + psycopg_pool, plain SQL | Native async, `set_config` per transaction for RLS adoption, no second schema owner (no ORM migrations) |
| JWT (Phase 1) | PyJWT with JWKS (ES256) | Local Supabase CLI 2.120 signs user tokens with ES256 (verified); HS256 supported only if configured |
| Supabase CLI | `supabase` npm devDependency, pinned 2.120.0 | Reproducible CLI version for every developer and CI |
| Node | `.nvmrc` = 22 (LTS) for CI; developed on Node 26 | |
