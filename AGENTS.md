# AGENTS.md — CampusCart

Guidance for any coding agent (or human) working in this repository. Read this file,
`docs/IMPLEMENTATION_STATUS.md`, and `docs/ARCHITECTURE.md` before changing anything.

## Phase gating (overrides everything else)

Work happens in strict phases: 0 → 1 → 2 → 3 → 4 → 5 → 6A → 6B → 6C → 7 → 8.

- Implement **only** the phase the user has authorized (`Continue to Phase N`). Never start the next one automatically.
- Each phase follows: inspect, plan, implement, verify, document, stop.
- A phase is `COMPLETE` only when its acceptance criteria were verified by commands that were actually run.
- At the end of each phase, update `docs/IMPLEMENTATION_STATUS.md` (and `docs/ARCHITECTURE.md` / this file if needed), then report using the 9-section format: phase and status · what was implemented · files/migrations · commands run · actual results · bugs/limitations/blockers · acceptance criteria done/outstanding · next phase · exact command to continue.
- Out of scope permanently: campus navigation and the RL Campus Navigator.

## Requirements

- Product requirements: `CampusCart_Team_Orbiz_Report.pdf/.docx` (in `~/Documents/Projects/`) plus the master build prompt.
- Traceability and conflicts: `docs/REQUIREMENTS.md`. When an `OPEN` decision blocks work, build the documented default and say so. Never silently invent behaviour.
- Built from scratch. Do not import code from other folders on this machine.

## Layout

```
apps/student-web  apps/manager-dashboard  apps/pos-dashboard   Next.js 16 (ports 3000/3001/3002)
apps/student-mobile                                            Expo (Phase 3)
packages/contracts   shared API types      packages/config   tsconfig presets
packages/client      framework-free client logic (all apps)   packages/staff-web   React for both dashboards
services/api         FastAPI (only writer of business state)
supabase/            migrations, seeds, pgTAP tests (schema source of truth)
ml/  services/intelligence/   offline training / inference boundary (Phases 6–7)
```

## Commands

```bash
pnpm install                       # JS deps (pnpm 12, pinned via packageManager)
pnpm dev:student-web               # or dev:manager, dev:pos
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm format                        # Prettier (TS/JSON/YAML; Markdown and Python excluded)

cd services/api
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/uvicorn app.main:app --reload --port 8000
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest -q

pnpm db:start                      # local Supabase in Docker (Postgres, Auth, Realtime, Mailpit)
pnpm db:reset                      # re-apply all migrations + dev seeds
pnpm db:test                       # pgTAP tests (schema invariants, RLS, privileges)
eval "$(bash scripts/supabase-env.sh)"   # export API/test env from the running stack
(cd services/api && .venv/bin/pytest -q -m integration)   # real GoTrue + Postgres

bash scripts/verify.sh             # everything above, fails fast (DB steps skipped if stack is down)
```

Dev accounts (fictional, local only) are listed in `supabase/seeds/01_dev_identity.sql`.

```bash
pnpm contracts:generate            # after any API schema change: regenerate @campuscart/contracts (commit both files)
bash scripts/web-env.sh student-web http://localhost:8000      # write a client app's env from the local stack
bash scripts/web-env.sh student-mobile http://<LAN-IP>:8000    # (mobile writes apps/student-mobile/.env)
(cd apps/student-web && pnpm exec playwright test)             # website E2E (starts/reuses API :8100 + web :3100)
(cd apps/pos-dashboard && pnpm exec playwright test)           # POS E2E (web :3102); manager-dashboard uses :3101
pnpm --filter @campuscart/student-mobile e2e                   # mobile app (RN Web build) E2E
pnpm --filter @campuscart/student-mobile export:native         # iOS + Android bundles
```

## Non-negotiable rules

1. **Server is authoritative.** Prices, totals, availability, stock, slot capacity, payment state and order status are decided by the API and DB, never by a client.
2. **Money is integer paise.** No floats for currency, anywhere.
3. **RLS on every `public` table.** Never disable RLS or bypass auth to make something work. Privileged keys stay server-side.
4. **Explicit state machine.** Order status changes go through the backend transition table only.
5. **Transactions + locking** for any multi-row change (order create, stock, slots, payments, ledgers). No check-then-write races.
6. **Idempotency** for retryable mutations and webhooks. Financial ledgers are append-only.
7. **No fabrication.** No fake orders, metrics, model results, payment successes, or seeded "production-looking" data. Empty states are honest. Synthetic data is labelled synthetic.
8. **No secrets in git.** Only placeholder `.env.example` files are tracked. Browser and mobile code gets only `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` values.
9. **RL/LLM are constrained advisors.** They choose only from valid actions the API supplies, have deterministic fallbacks, and can never override inventory, payment, permission or state rules.
10. **Don't claim what you didn't run.** Report failures with their output.

## Conventions

- TypeScript: strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Import backend types from `@campuscart/contracts`, never redeclare them.
- Python: ruff (rules in `pyproject.toml`), mypy `--strict`, settings via `CAMPUSCART_*` env vars in `app/core/config.py`. Route handlers stay thin; logic goes in service modules.
- API errors use the envelope in `app/core/errors.py` (raise `ApiError`). Every response has `X-Request-ID`.
- New settings are declared in the phase that uses them and added to the relevant `.env.example`.
- Migrations: `pnpm exec supabase migration new <name>`, hand-written SQL, reviewed. Never edit a migration that has been pushed/shared; add a new one.
- Every new `public` table: `enable row level security`, `revoke all ... from anon, authenticated` then grant the minimum (Supabase grants ALL by default), at least one policy, and pgTAP tests incl. negative cases. `01_schema.test.sql` fails if RLS or a policy is missing.
- RLS helpers live in the `private` schema (`private.is_admin()`, `private.is_outlet_staff(id)`, `private.is_outlet_manager(id)`); `SECURITY DEFINER` functions must `set search_path = ''`.
- User-scoped API work goes through `Database.user_transaction(principal)` so RLS applies; never query user data on a bare privileged connection. Public catalogue reads use `anon_transaction()`; trusted server operations (payments, jobs) use `system_transaction()`.
- Multi-row business invariants live in `SECURITY DEFINER` functions in the `app` schema (not exposed by PostgREST). They authorise explicitly, lock in the order outlet → inventory (by id) → slot → order, and fail with `private.fail(<http status>, '<reason>', '<message>')` (SQLSTATE `CC<status>`), which the API maps to the error envelope.
- Order status changes only via `app.transition_order` (rules in `order_status_transitions`), `app.verify_pickup`, `app.confirm_order_payment` (system-only), `app.expire_pending_orders` or `app.process_no_shows` (cron). Never `update orders set status` elsewhere.
- Dashboards share React code via `packages/staff-web` (React 19.3, same as the Next apps); its Tailwind classes are picked up through `@source` in each app's `globals.css`.
- Client apps: shared, framework-free logic goes in `packages/client` (no React there, because web and Expo use different React versions). UI must never compute prices, totals, availability or allowed transitions; read them from the API (`canTransition` uses `GET /orders/transitions`).
- Every user-visible flow added to a client gets a Playwright test against the real backend; keep the axe and no-horizontal-scroll checks green.
- Money: only `private.mark_order_paid` marks an order paid; wallets and points change only through `private.wallet_post` / `private.loyalty_post` (append-only ledgers). Tests fund wallets through `app.register_payment` + `app.capture_payment` as the system role (the webhook path), labelled as a stand-in.
- Tests that need a "paid" order use the labelled stand-in `confirm_payment()` / `tests.pay()`, which calls the same system-only function the Phase 5 webhook will.
- Tests live next to the code (`*.test.ts`) or in `services/api/tests/`. Every authorization rule gets a negative test.
- pnpm blocks dependency install scripts. Allow one only via `allowBuilds` in `pnpm-workspace.yaml`, with a comment saying why.
