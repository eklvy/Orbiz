# @campuscart/contracts

The single TypeScript source of API contracts for all four CampusCart clients
(student web, student mobile, manager dashboard, POS/kitchen dashboard).

**Current state (Phase 0):** only the shared error envelope and the API version prefix.

**Plan:** from Phase 2 onwards, request/response types are generated from the FastAPI
OpenAPI schema (`openapi-typescript`) into `src/generated/`, and hand-written code here
is limited to small helpers. Clients must never re-declare backend business types locally.
