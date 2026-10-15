# CampusCart — Implementation Status

Status vocabulary: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `INCOMPLETE` · `COMPLETE`.
A phase is `COMPLETE` only when its acceptance criteria were verified by commands actually run.

Last updated: 2026-10-15 (Phase 4).

## Phase overview

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository inspection, architecture, scaffolding, tooling | **COMPLETE** |
| 1 | Database, authentication, authorization, RLS | **COMPLETE** |
| 2 | Core backend, ordering, inventory, real-time events | **COMPLETE** |
| 3 | Student website + student mobile app | **COMPLETE** (native simulator run blocked) |
| 4 | Manager dashboard + POS/kitchen dashboard | **COMPLETE** (RLS mutation check outstanding) |
| 5 | Payments, wallets, group orders, notifications, loyalty, budgets, specials/polls/reviews | **IN PROGRESS** |
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

**CI:** Phase 1 was pushed as PR #1. All three jobs (TypeScript, Python, Database) passed on GitHub.

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

## Phase 2 — COMPLETE

Branch `phase-2/ordering-inventory-realtime`, stacked on Phase 1 (PR #1, whose CI passed on GitHub, including the database job).

### Decisions applied
- D-2 (seats/crowd): **default implemented.** Crowd level and wait come from real order load only; no seat counts.
- D-12 (stock model), D-17 (wait estimate): implemented as documented.
- New D-18 (pay at counter) and D-19 (no-show policy): **open.** Defaults: no counter payment; no automatic no-show
  handling (`ready_for_pickup` stays until the pickup code is verified).

### Delivered

**Migrations** (`supabase/migrations/20261014…`):

| Migration | Contents |
|---|---|
| `120000_outlet_operations` | Outlet status (open / on_break / closed + reason + break end), time zone, token prefix, slot length/capacity, reservation TTL, kitchen concurrency; `outlet_hours` |
| `120100_menu_inventory` | `menu_categories`, `menu_items` (paise prices, diet, kcal/protein, prep time, manual status, derived `stock_status`), `inventory`, append-only `inventory_movements`; status-derivation triggers |
| `120200_pickup_slots` | `pickup_slots` with `CHECK (reserved_count <= capacity)` |
| `120300_orders` | Order state machine table; `orders` (paise totals, idempotency key + request hash, reservation expiry, token, version, invariants as CHECKs), `order_items` (snapshots), `order_events`, `order_pickup_codes` (owner-only), token counters; RLS (incl. own-order visibility of outlet and slot) |
| `120400_carts` | Server-side `carts` / `cart_items` (composite FKs keep items in the cart's outlet) |
| `120500_order_functions` | `app` schema: `create_order`, `transition_order`, `confirm_order_payment` (system-only), `verify_pickup`, `expire_pending_orders`, `end_expired_breaks`, `set_outlet_status`, `adjust_stock`, `set_stock_tracking`, `set_item_manual_status`, `generate_pickup_slots`, `generate_upcoming_slots`, `outlet_queue_stats`, `order_queue_position` |
| `120600_realtime_and_jobs` | Realtime publication (orders, order_events, outlets, menu_items, inventory, pickup_slots) and three `pg_cron` jobs |

**Seeds:** `02_dev_menu.sql` adds fictional menus, hours, stock, and today plus the next 2 days of slots for the dev outlets.

**API:** catalogue (`/outlets`, menu with filters, pickup slots), server-side `/cart`, `/orders` (create with
`Idempotency-Key`, list with cursor, detail with events / queue position / owner-only pickup code, cancel), `/orders/transitions`,
`/staff` (queue, transitions, pickup verification), `/manage` (outlet status, stock adjust/tracking/availability, slot
generation). DB errors map to the envelope with `details.reason`. `Database.anon_transaction()` and
`system_transaction()` were added. See [API.md](API.md).

**Contracts:** `pnpm contracts:generate` writes `packages/contracts/openapi.json` and `src/generated/api.ts`. A staleness
check is in `verify.sh` and CI, and a compile-time error-code drift guard is in place.

### Verification (actually run, 2026-10-13)

| Check | Result |
|---|---|
| `supabase db reset` | All 11 migrations and 2 seeds apply cleanly; 252 slots generated for the dev outlets |
| pgTAP (`supabase test db`) | **166/166 pass**: Phase 1 (56) + menu/stock/outlet ops (31), order creation (29), lifecycle (38), jobs/Realtime publication (12) |
| Unit tests (`pytest -m "not integration"`) | **48/48** (23 new: request fingerprint, payload rejects client prices, cursors, crowd thresholds, DB-error mapping) |
| Integration tests (`pytest -m integration`) | **30/30** against real GoTrue + Postgres + Realtime (66 s) |
| Concurrency: stock | 25 simultaneous buyers, 5 in stock → **exactly 5 succeed**, 20 get `insufficient_stock`; stock 0; 5 orders; 5 slot places; ledger = 5 |
| Concurrency: slot | 25 buyers, slot capacity 2 → **exactly 2 succeed**, 23 `slot_full`, no stray rows |
| Concurrency: HTTP | 6 real users through the ASGI app, 2 in stock → two 201s, four 409 `insufficient_stock` |
| Atomicity | A later line failing rolls back earlier reservations (pgTAP: stock, slot and order count unchanged) |
| Full flow over HTTP | create → (verified-payment stand-in) → token `T-n` + pickup code → staff queue (no code) → confirmed → preparing → ready → wrong code (counted and committed) → right code → completed; history lists it |
| Authorization | Cross-user order read/cancel → 404; non-staff queue → 403; kitchen/student stock changes → 403; end users cannot confirm payments (42501); staff never see pickup codes |
| Reservation expiry via **real pg_cron** | Overdue order cancelled by `system` within 11 s; stock and slot released |
| Realtime | Kitchen saw a new order in 450 ms; student received 30/30 status changes, **p95 543 ms** request→event (p50 532), commit→event p95 539 ms; bystander student received **none** of them |
| Contract drift guard | Adding a fake error code makes `tsc` fail; removing it passes |
| ruff / mypy `--strict` / ESLint / tsc / Vitest / Next builds | Pass |
| `bash scripts/verify.sh` | "All checks passed." |

**Bugs found and fixed during verification:**
- Queue position tied when two orders shared `placed_at`. It now breaks ties by token.
- Two `generate_series`/union typing errors in the seed and slot generation.
- Several of my own test expectations were wrong; the code was right.

**Not verified:**
- The new CI database steps haven't run on GitHub; Phase 2 isn't pushed yet.
- Latency was measured locally only, with one subscriber and sequential changes. Load and hosted measurements are Phase 8.

### Acceptance criteria
- [x] A test client can create and track valid orders (HTTP flow test, Realtime test)
- [x] Invalid transitions are rejected (pgTAP + HTTP; the table-driven state machine)
- [x] Stock and capacity are protected against concurrent reservations (25-way DB races, 6-way HTTP race, CHECK constraints)
- [x] Authorized clients receive real events, and unauthorized ones don't (Realtime isolation test)

### Known limitations (Phase 2)
- **No real payments yet (Phase 5).** Orders stay `payment_pending` and expire unless trusted server code confirms them.
  Tests use a clearly labelled stand-in that calls the same system-only function the webhook will.
- Refunds are only *marked* (`refund_status = required`); money movement is Phase 5.
- Menu, category, hours and slot-capacity editing UIs and endpoints are Phase 4 (seeded or SQL for now). Kitchen stations and
  assignments are Phase 4/6.
- There's no general API rate limiting yet (only the 3-unpaid-orders cap and pickup-code lockout). Planned for Phase 8.
- Carts aren't live-synced over Realtime (see above). Clients refetch.
- Queue position and wait estimate are simple, transparent heuristics, not predictions.
- Slot deactivation with existing reservations isn't guarded yet (no endpoint exposes it; Phase 4 must handle it).

---

## Phase 3 — COMPLETE (native simulator run blocked; see below)

Built on the Phase 2 working tree (branch `phase-2/ordering-inventory-realtime`; Phases 2 and 3 are not committed yet).

### Delivered

**`packages/client`** (new): framework-free logic shared by both student apps:
- `openapi-fetch` client typed by `@campuscart/contracts`, with bearer-token middleware and a `CampusCartApiError` that carries the server's `details.reason`
- typed calls for every student endpoint; shared TanStack Query keys
- `friendlyError()` (messages plus a next-step hint), rupee/time/slot/countdown formatting in the outlet's time zone
- order timeline, `canTransition()` driven by the server's rule table (no duplicated state machine), `isNewerVersion()` for Realtime dedupe, and the pickup QR payload
- Zod schemas mirroring the database and Auth password rules; signup-metadata and profile-update mappers
- `subscribeToTable()` (resyncs on every (re)connect); idempotency keys

There is deliberately no React in it: the web app (React 19.3) and Expo (19.2.3) must not share a React copy, so each app has a thin hooks file.

**Student website** (`apps/student-web`, Next.js 16):
- Auth: register (student/faculty, roll-number rules), sign in with a safe `next` redirect, sign out, forgot/reset password (no email enumeration)
- Discovery: live outlet status, wait estimate, queue length, crowd level, with a note that these come from orders, not sensors
- Menu: categories; search, diet, max-price and available-only filters; item details with nutrition and an allergen disclaimer; sold-out/low badges; live stock and item updates
- Server cart: steppers, an explicit "start a new cart" prompt when switching outlets, unavailable items flagged
- Checkout: slot picker grouped by day with remaining capacity; one idempotency key per distinct request; slot or stock errors refresh the right data
- Order tracking: live status and Realtime indicator, timeline, queue position, QR Digital Food Pass with token and pickup code, reservation countdown, **honest "Awaiting payment" with a disabled "Pay (coming soon)" button**, cancellation from the server rules, a refund-owed notice, and event history
- Paginated history; profile editing
- Loading, empty, error and offline states; skip link; focus styles; light and dark tokens

**Student mobile** (`apps/student-mobile`, Expo SDK 57 / RN 0.86 / Expo Router):
- Tabs (Outlets, Orders, Cart with badge, Profile) and the same flows as the website
- LargeSecureStore session storage (Keychain/Keystore AES key plus encrypted AsyncStorage), AppState-aware token refresh, NetInfo offline banner and TanStack online manager
- RN-Web-safe confirm prompts, QR via `react-native-svg`

**Tooling:**
- `scripts/web-env.sh` writes app env files from the local stack
- Playwright suites for the website (desktop and Pixel 7) and the mobile web build
- `verify.sh` and CI run the bundles and both browser suites
- Local Auth rate limit raised for tests (local only; documented in `config.toml`)

### Bugs found by these tests and fixed
- **Backend race:** two quick "Add" taps raced to create the cart (`carts_pkey` violation → 500). Cart writes are now serialised per user (advisory lock). A regression test fails without the fix and passes with it.
- **UX:** after placing an order, the cart page flashed "Your cart is empty" before navigating. It now shows "Order placed. Opening your order…".
- **Mobile layout:** the header, then the profile's two-column fields, overflowed horizontally at 412 px. Fixed, and guarded by a new "no page scrolls horizontally" test.
- Integration-test outlets are now deactivated on teardown instead of piling up in the public dev catalogue.

### Verification (actually run, 2026-10-13/14)

| Check | Result |
|---|---|
| `@campuscart/client` Vitest | 14/14 (formatting, time zones, timeline, rule-table decisions, version dedupe, validation mirrors DB rules, error-envelope mapping, network errors, idempotency keys) |
| Website Playwright (real Supabase + API, production build) | **18/18** on desktop and Pixel 7, passed in 3 consecutive runs. Covers register (with validation), sign-in redirect, order → stand-in payment → **live** token, kitchen steps and pickup without reloads → history, cancellation (the stock ledger nets to 0), filters and sold-out, a live stock change, axe-core WCAG 2.1 AA (no serious/critical violations on 7 pages), and no horizontal scroll |
| Mobile: typecheck, `expo lint` | Pass |
| Mobile: `expo export` iOS + Android | Hermes bundles built (4.4 MB / 4.8 MB) |
| Mobile: `expo-doctor` | 21/21 checks passed |
| Mobile app as React Native Web (Pixel 7, real backend) | **1/1**: sign in → menu → cart → slot → order → stand-in payment → live token → kitchen → "Collected" |
| Full `bash scripts/verify.sh` | "All checks passed." (also 166 pgTAP, 48 unit, 31 integration) |

**Environment note:** an early browser-test run failed because Postgres stalled (statements on tiny tables took 12–18 s; a checkpoint took 43 s). The 5-minute host load average reached 25–41 while Xcode was being installed and 4 browser workers ran. Playwright now uses 2 workers. This was not a code defect, and runs since have been green.

### Not verified / blocked
- **No native run on a device or simulator.** Xcode is now installed but has **no iOS runtime** (an ~8 GB download, left for you to start), and there's no Android SDK. Not exercised natively: Keychain/Keystore storage, native navigation gestures, AppState refresh, and real push to the OS. Phone testing is possible with Expo Go (see `apps/student-mobile/README.md`).
- The new CI steps (Playwright, mobile bundles) haven't run on GitHub; nothing since Phase 1 is pushed.

### Acceptance criteria
- [x] Both student clients use the same backend (same API, Supabase project, shared `@campuscart/client`)
- [x] Menu, cart validation, orders and order status come from real backend data (no hardcoded data; verified end to end)
- [x] The core student flow is tested: website on 2 viewports, and the mobile app via its web build. Native runs are blocked as described above.

### Known limitations (Phase 3)
- No real payment (Phase 5). The UI says so and holds the reservation honestly.
- Out of scope until later phases and not shown as placeholder buttons: group orders, wallet, loyalty, polls, reviews, notifications (Phase 5); BiteBot and Surprise Meal (Phase 7). RFID/QR login and guest mode follow D-3/D-4.
- Mobile password reset opens the website's reset page; there's no in-app deep link yet.
- Carts aren't pushed live between devices (see Phase 2); they refresh when opened.
- Local dev ports on this machine are 3100/8100, because another project's containers hold 3000/8000. The defaults stay 3000/8000.

---

## Phase 4 — COMPLETE (RLS mutation check not run; see below)

Branch `phase-4/manager-pos-dashboards`.

### Decisions applied
- **D-19 decided by the product owner (2026-10-14)** and implemented: pickup deadline = later of "ready" and
  "slot end" + 15 min; no refund; packaged items (per-item manager flag) back into stock; prepared items become
  one deal at 50% of what was paid, on sale 30 min, then recorded unsold; mixed orders split per item; a paid
  deal order goes straight to `ready_for_pickup` with a new token, and the counter shows the new owner. All
  three numbers are per-outlet settings. Defaults chosen by us and still open to change: deal orders that
  aren't collected are not relisted; the original student can't buy their own deal; a deal can't be bought
  while the outlet is closed.
- Refund requests: full amount only, within 24 h of pickup, one per order, not for no-shows (our defaults).
- D-7: both the POS app and the manager's Kitchen page render the same live board.

### Delivered
**Migrations** (`supabase/migrations/20261015…`): `120000_phase4_enums` (`no_show` status, `no_show_return`
ledger reason), `120100_outlet_management` (packaged flag + order-line snapshot, outlet no-show settings,
`private.pickup_deadline`, manager functions for categories/items/hours/settings/slots/staff,
`app.order_customer_names`, audit triggers on menu/categories/hours), `120200_refund_requests` (table, RLS,
request/decide/approve-all, Realtime), `120300_no_show_deals` (`surplus_deals` + items, slot-less deal orders,
two system transitions, `process_no_shows`, `expire_surplus_deals`, `claim_deal`, `withdraw_deal`, deal-aware
reservation release and payment confirmation, two pg_cron jobs, Realtime). Dev seed: Cold Coffee is packaged.

**API:** modules `deals`, `refunds`, `management`; staff queue returns `StaffOrder` (customer name, deal
source token); orders expose `pickup_deadline`, `no_show_at`, `source_deal_id`, `refund_request`, nullable
`pickup_slot`; `/me` memberships include the outlet time zone. Endpoints in [API.md](API.md).

**Clients:** `packages/client` gains the staff/manager API, `parsePickupQr`, `parseRupeesToPaise` (no float
math), `formatTimeLeft`, event labels. New `packages/staff-web` (sign-in gate, outlet picker, live
`KitchenBoard`, pickup scanner, `DealsPanel`, UI). **POS app**: live board (New → Accepted → Preparing →
Ready), reject/cancel with reason, pickup by code or scanned QR, collect-by countdown, uncollected orders &
deals with withdraw. **Manager app**: overview (Open / Break with duration + public reason / Close; today's
figures; campus fleet table), kitchen, menu & stock (add/edit/archive items, packaged flag, availability,
restock, start/stop counting, today's counts, categories), refunds desk (approve, decline with note, approve
all, owed refunds, median decision time), slots & hours, staff (add kitchen staff by email, remove),
settings (incl. the no-show policy numbers). **Student website + mobile app**: discounted deals on the outlet
page, buying a deal, "not collected" explanation, collect-by notice, refund request and its decision.

### Verification (actually run, 2026-10-15)
| Check | Result |
|---|---|
| `bash scripts/verify.sh` (one clean run) | **"All checks passed."** |
| Prettier, `tsc` (all packages), ESLint (incl. new `staff-web` lint) | Pass |
| Vitest | contracts 3/3, client **20/20** (new: QR parsing, rupee input without float error, time-left, no-show labels, `canManage`) |
| Next.js production builds | 4/4 apps (manager: 8 routes; POS: 1) |
| Mobile Hermes bundles | iOS + Android built |
| ruff / mypy `--strict` | Pass (59 files) |
| Contracts up to date | Pass |
| pytest unit | 48/48 |
| `supabase db reset` | 15 migrations + 2 seeds apply cleanly |
| pgTAP | **274/274** across 11 files (new: manager ops 39, refunds 24, no-show & deals 45; jobs/Realtime test updated) |
| pytest integration (real GoTrue + Postgres) | **37/37** (new: 6 — no-show → deal → **5-way race, exactly one buyer wins** → new owner at the counter → pickup; withdrawal and access; settings/hours; menu edits reach students + today's counts + summary; slots and staff; refunds desk) |
| Student website E2E | **22/22** desktop + Pixel 7 (new: no-show explanation live + another student buys the deal; refund request and live decision) |
| Student mobile E2E (RN Web) | **2/2** (new: no-show live + deal bought by another app user) |
| POS E2E | **14/14** desktop + tablet (live order, full kitchen flow, wrong/right code, scanned QR, reject with reason → refund owed, no-show → deal → buyer shown at counter, withdraw, staff-only gate, axe + no sideways scroll) |
| Manager E2E | **12 passed, 2 skipped by design** desktop + Pixel 7 (status/break, menu add/reprice/sold-out/restock, refunds approve/decline live, staff add/remove, slots & settings, kitchen refused, axe + overflow on all 7 sections ×5 repeats) |

Also run by hand in the browser (dev servers, real pg_cron): order → POS live → Accept/Start/Ready → order
moved past its deadline → pg_cron made it a no-show, bottled coffee restocked (24 → 25), sandwich listed at
₹35 (₹70 paid) → another student bought and paid → the POS showed "N-2 · Dev Student Two · Deal · was N-1"
→ handed over with the pickup code. Kitchen account refused by the manager app.

**Bugs found and fixed:** a stale API from the previous session was still serving old code on :8100
(Playwright would have reused it); the fleet table's scroll container wasn't keyboard-reachable; archived menu
items used opacity and failed colour contrast; long countdowns read "454:58"; the dashboards read env during
static prerender (they now render only in the browser); a test waited on the previous page's heading.

**Not verified:**
- **RLS mutation check** (temporarily weakening the new policies to prove the tests catch it) was blocked by
  the session's auto-mode safety classifier. The new negative tests exist (anon/student/kitchen/other-outlet
  cases in pgTAP and HTTP), but the mutation run itself is outstanding.
- New CI steps haven't run on GitHub until the branch is pushed.

### Acceptance criteria
- [x] Managers can control outlet status, menu, stock, slots, hours, staff and settings for their outlets only
- [x] Kitchen staff run the live queue and pickup from a separate POS app; managers see the same board
- [x] Refund requests can be approved/declined (singly and in bulk) with an audit trail
- [x] The no-show policy (D-19) runs automatically and the counter sees a resold deal's new owner live
- [x] Every new flow has backend, database and browser tests against the real stack

### Known limitations (Phase 4)
- Refund approval records money as owed; payout is Phase 5. Deals and orders are still paid via the test
  stand-in until Phase 5.
- Specials/polls and reviews (report §3.3, §3.7) are Phase 5; demand forecast is Phase 7 — not shown as
  placeholders.
- Camera QR scanning isn't built; the counter uses a keyboard-wedge scanner or the typed code.
- `inventory` has no outlet column, so the manager menu refetches on any outlet's stock change.
- Students aren't notified (push/email) when their order becomes a no-show; notifications are Phase 5.

---

## Phase 5 — IN PROGRESS

Branch `phase-5/payments-wallet-social` (from `main` after merging Phase 4, PR #3).

### Decisions (product owner, 2026-10-15)
D-6 no signup bonus · D-15 loyalty: 1 pt per ₹10 paid, +50 for a ₹999+ top-up, +15 per review, tiers
Silver 0 / Gold 1,000 / Platinum 3,000 lifetime points, 100 pts = ₹10 voucher, reversed on refund ·
D-18 online payment only.

### Defaults we chose (open to change; see REQUIREMENTS.md D-20…)
- Refunds owed are paid into the student's CampusCart wallet automatically (instant, ledgered). Card refunds
  through Razorpay are not built.
- Wallet: top-up ₹50–₹5,000 via Razorpay; balance cap ₹10,000; no withdrawal to bank; transfers only to
  settle bill splits and group-order shares.
- Mobile app pays from the wallet; top-ups happen on the website (Razorpay Checkout is web-only without a
  native module).
- Without Razorpay test keys, payment code is verified with locally signed test webhooks/signatures and a
  stubbed provider API; it has not talked to Razorpay. Without an Expo token, push is stored but not sent.

### Plan (milestones, in order)
1. Money core: `payments` (Razorpay orders, signature verify, signed idempotent webhooks), wallet accounts +
   append-only ledger, pay-with-wallet, refund payout to wallet, shared `private.mark_order_paid`.
2. Loyalty ledger, tiers, vouchers (redeem; apply to an unpaid order), budget planner.
3. Notifications centre (table, triggers, Realtime, unread count; Expo push if configured).
4. Specials (portions, discount priced by the server at order time), polls (one vote, manager publishes the
   winner as tomorrow's special), reviews (4 dimensions, +15 pts, staff replies, outlet leaderboard),
   "popular with your classmates" (k ≥ 5).
5. Group orders (shared tray, add for a member, split by dish / equally / %, per-member wallet payment),
   party sessions (catering requests a manager accepts, paid from the wallet), bill splits (settled by wallet
   transfer).
6. Student web + mobile screens, manager screens (specials, polls, reviews, party requests), tests, docs.

---

## Prerequisites and blockers for upcoming phases

| Needed for | Item | Status |
|---|---|---|
| Phase 1 | Supabase CLI + Docker | Done (CLI 2.120.0 pinned; Docker Desktop running) |
| Any | Decisions D-4, D-10, D-11 | Defaults implemented; can be changed later (D-11: insert real domain(s) into `private.allowed_email_domains`) |
| Pilot | Real outlet list and menus (D-14) | OPEN (dev seeds are fictional) |
| Phase 2 | Decision D-2 (seat/crowd data source) | OPEN, default documented |
| Phase 3+ | Native mobile testing | Xcode installed, **iOS runtime missing** (`xcodebuild -downloadPlatform iOS`, ~8 GB); no Android SDK. Expo Go on a phone works without either |
| Phase 5 | Razorpay **test-mode** key ID, key secret, webhook secret | Not provided |
| Phase 5 | Expo push access token; decisions D-6 (signup bonus), D-15 (loyalty policy), D-18 (pay at counter) | Not provided / OPEN |
| Phase 7 | LLM provider choice for BiteBot (optional; must work without one) | Not decided |
| Staging/prod | Supabase projects, hosting targets, domain | Not provided |

## Known limitations (Phase 0)

- App pages are placeholders that say so explicitly.
- pnpm was installed globally with `npm i -g pnpm@12.11.2`, since Node 26 doesn't ship corepack.
