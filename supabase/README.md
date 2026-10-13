# supabase/

Database source of truth, following Supabase CLI conventions.

- `migrations/` — ordered SQL migrations (`YYYYMMDDHHMMSS_description.sql`). The only way schema changes.
- `seeds/` — development seed data (clearly fake, local/test only; never run against production).
- `tests/` — pgTAP tests for constraints and RLS (run with `supabase test db`).

Empty in Phase 0. Phase 1 runs `supabase init`, adds `config.toml`, and creates the first migrations.
See docs/ARCHITECTURE.md §6 for the workflow.
