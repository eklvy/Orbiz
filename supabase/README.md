# supabase/

Database source of truth, following Supabase CLI conventions.

- `migrations/` — ordered SQL migrations (`YYYYMMDDHHMMSS_description.sql`). The only way schema changes.
- `seeds/` — development seed data (clearly fake, local/test only; never run against production).
- `tests/` — pgTAP tests for constraints and RLS (run with `supabase test db`).

Commands (from the repo root): `pnpm db:start`, `pnpm db:reset`, `pnpm db:test`, `pnpm db:stop`.
Test helpers shared by all pgTAP files live in `tests/_helpers.psql` (not a test itself).
See docs/ARCHITECTURE.md §5–6 for the security model and workflow.
