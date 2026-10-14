# CampusCart API (v1)

The machine-readable contract is the OpenAPI schema. It's served at `/openapi.json` and `/docs` outside production,
and committed as `packages/contracts/openapi.json`. TypeScript types are generated from it into
`@campuscart/contracts` (`pnpm contracts:generate`). CI fails if the committed types are stale.

## Conventions

- **Base path:** `/api/v1`. JSON in and out. Money is always **integer paise** (`price_paise`, `total_paise`).
- **Auth:** `Authorization: Bearer <Supabase access token>`. Catalogue reads are public.
- **Errors:** every error uses one envelope:
  ```json
  {"error": {"code": "conflict", "message": "Not enough Cold Coffee left", "request_id": "…", "details": {"reason": "insufficient_stock"}}}
  ```
  `code` is one of `validation_error`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `rate_limited`,
  `service_unavailable`, `internal_error`. Business failures add a machine-readable `details.reason` (table below).
- **Request IDs:** every response carries `X-Request-ID`. Send your own (≤ 64 safe characters) to correlate.
- **Idempotency:** `POST /orders` requires `Idempotency-Key` (8–100 chars, unique per checkout attempt). A retry with the
  same key and body returns the original order. The same key with a different body gives `409 idempotency_key_reused`.
- **Pagination:** `GET /orders` is cursor-based. Pass back `next_cursor` as `?cursor=`.
- **Visibility:** an order you may not see returns `404`, not `403`, so its existence isn't revealed.

## Endpoints

| Method & path | Who | Purpose |
|---|---|---|
| `GET /health`, `GET /health/ready` | anyone | Liveness / database readiness |
| `GET /me`, `PATCH /me` | signed in | Own profile, roles, outlet memberships; edit allowed fields |
| `GET /outlets` | public | Active outlets: effective status, `accepting_orders`, queue stats (`active_orders`, `estimated_wait_minutes`, `crowd_level`) |
| `GET /outlets/{id-or-slug}` | public | Same plus opening hours |
| `GET /outlets/{id}/menu` | public | Categories and items. Filters: `category_id`, `diet`, `max_price_paise`, `q`, `available_only` |
| `GET /outlets/{id}/pickup-slots` | public | Upcoming slots (48 h, or `?date=` local date) with `remaining` capacity |
| `GET /cart`, `PUT /cart/items/{item}`, `DELETE /cart/items/{item}`, `DELETE /cart` | signed in | Server-side cart, one outlet at a time (`replace_cart: true` to switch outlets) |
| `GET /orders/transitions` | public | The order state machine (every legal move and who may make it) |
| `POST /orders` | signed in | Create an order: validates and reserves stock + slot atomically. Returns `201` with an unpaid order |
| `GET /orders`, `GET /orders/{id}` | owner / outlet staff / admin | History (paginated) and detail with events, queue position, pickup code (owner only) |
| `POST /orders/{id}/cancel` | owner | Cancel while unpaid, or paid but not yet accepted |
| `GET /staff/outlets/{id}/orders?status=` | outlet staff | Kitchen queue (active orders by default), ordered by slot |
| `POST /staff/orders/{id}/transition` | outlet staff | `confirmed`, `preparing`, `ready_for_pickup`, `rejected`, `cancelled` (reason required for the last two) |
| `POST /staff/orders/{id}/verify-pickup` | outlet staff | Complete the order with the student's pickup code (5 wrong attempts lock it) |
| `POST /manage/outlets/{id}/status` | outlet manager / admin | `open`, `on_break` (+ `break_minutes`), `closed`, with a public reason |
| `POST /manage/menu-items/{id}/stock-adjustments` | outlet manager / admin | Restock or correct a tracked quantity (ledgered) |
| `PUT /manage/menu-items/{id}/stock-tracking` | outlet manager / admin | Turn quantity tracking on or off, set quantity and low threshold |
| `PUT /manage/menu-items/{id}/availability` | outlet manager / admin | Manual `available` / `low` / `sold_out` |
| `POST /manage/outlets/{id}/pickup-slots/generate` | outlet manager / admin | Create a date's slots from opening hours (idempotent) |

Payment confirmation has **no endpoint**. Only trusted server code can mark an order paid
(`app.confirm_order_payment`, `service_role`). Phase 5 calls it after verifying the payment with Razorpay.

## Order lifecycle

```
payment_pending ──(verified payment, system)──► placed ──► confirmed ──► preparing ──► ready_for_pickup ──(pickup code)──► completed
     │ student cancel / reservation expiry          │ student cancel   │ staff cancel  │ staff cancel
     ▼                                              │ staff reject     ▼               ▼
 cancelled                                          ▼              cancelled       cancelled
                                            cancelled / rejected
```

`GET /orders/transitions` returns the authoritative table, with each move's actor, payment requirement, whether it
needs a reason, whether it releases stock and/or the slot, and whether a refund becomes owed (`refund_status: required`,
settled in Phase 5). No transition is reversible.

## Business error reasons (`details.reason`)

| Reason | HTTP | Meaning |
|---|---|---|
| `outlet_not_found` / `item_not_found` / `order_not_found` | 404 / 422 / 404 | Not found or not visible |
| `outlet_not_accepting_orders` | 409 | Closed or on a break (message includes the public reason) |
| `item_unavailable` | 409 | Item is sold out |
| `insufficient_stock` | 409 | Not enough tracked quantity left |
| `slot_unavailable` / `slot_full` / `slot_too_soon` | 409 | Slot inactive or another outlet's / no capacity / sooner than the longest prep time |
| `too_many_pending_orders` | 409 | Already 3 unpaid orders |
| `idempotency_key_reused` | 409 | Same key, different request |
| `invalid_transition` / `payment_required` / `pickup_code_required` | 409 | State-machine violations |
| `reason_required` | 422 | Rejection or staff cancellation without a reason |
| `invalid_pickup_code` / `pickup_code_locked` | 422 / 429 | Wrong code / 5 wrong attempts |
| `cart_outlet_mismatch` | 409 | Cart holds another outlet's items (`replace_cart: true` to switch) |
| `forbidden` | 403 | Not a manager of that outlet |

## Realtime

Subscribe with Supabase Realtime (`postgres_changes`) using the user's access token. RLS applies per subscriber.

| Table | Who receives changes |
|---|---|
| `orders`, `order_events` | The order's owner; staff of its outlet (filter e.g. `outlet_id=eq.<id>`) |
| `outlets`, `menu_items`, `inventory`, `pickup_slots` | Anyone who can see the row (public catalogue) |

Not published: carts (Realtime doesn't filter DELETE events by RLS), pickup codes, and the stock ledger. Clients must
refetch authoritative state on (re)connect and use `orders.version` to ignore stale or duplicate events.
