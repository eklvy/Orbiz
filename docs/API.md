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
- **Idempotency:** `POST /orders` and `POST /deals/{id}/claim` require `Idempotency-Key` (8–100 chars, unique per checkout attempt). A retry with the
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
| `GET /outlets/{id}/deals` | public | Surplus deals on sale now (prepared food from uncollected orders, D-19), server-priced |
| `POST /deals/{id}/claim` | signed in | Buy a deal: creates an unpaid order (no slot) holding the deal; once paid it is `ready_for_pickup` straight away |
| `POST /orders/{id}/refund-request` | owner | Ask for a refund on a collected order (within 24 h). Not allowed for `no_show` |
| `GET /staff/outlets/{id}/deals` | outlet staff | Deals listed in the last 24 h with source token, buyer token and status |
| `POST /staff/deals/{id}/withdraw` | outlet staff | Take an on-sale deal off sale (reason required) |
| `GET /manage/outlets`, `GET /manage/outlets/{id}` | manager / admin | Managed outlets (admins: all) with settings, hours and live load |
| `PATCH /manage/outlets/{id}/settings` | manager / admin | Name/location/description, slot defaults, hold time, kitchen concurrency, no-show grace, deal discount and listing time |
| `PUT /manage/outlets/{id}/hours` | manager / admin | Replace the weekly opening hours (no overlaps) |
| `GET /manage/outlets/{id}/summary` | manager / admin | Today's real figures: paid orders by status, paid total, refunds owed, no-shows, deals |
| `GET /manage/outlets/{id}/menu` | manager / admin | Every item incl. archived, with stock detail and today's order counts |
| `POST /manage/outlets/{id}/menu-items`, `PUT /manage/menu-items/{id}` | manager / admin | Create / replace an item (integer paise, packaged flag, archive via `is_active`) |
| `POST /manage/outlets/{id}/categories`, `PUT/DELETE /manage/categories/{id}` | manager / admin | Categories (deleting un-categorises items) |
| `GET /manage/outlets/{id}/pickup-slots?date=`, `PATCH /manage/pickup-slots/{id}` | manager / admin | All slots of a date; change capacity (not below booked) or stop/resume bookings |
| `GET/POST /manage/outlets/{id}/staff`, `DELETE /manage/outlets/{id}/staff/{user}` | manager / admin | Staff list with emails; add kitchen staff by email; remove kitchen staff (admins: any role) |
| `GET /manage/outlets/{id}/refunds` | manager / admin | Refunds desk: pending requests, recent decisions, refunds owed, median decision time |
| `POST /manage/refund-requests/{id}/decision`, `POST /manage/outlets/{id}/refunds/approve-all` | manager / admin | Approve (refund becomes owed; paid out in Phase 5) or decline with a note; approve all pending |

The staff queue returns `StaffOrder`: an order plus `customer_name` and, for deal orders, `deal_source_token`
(never the pickup code). Every order carries `pickup_deadline` while `ready_for_pickup`, `no_show_at`, and
`source_deal_id`; `pickup_slot` is `null` for deal orders. `GET /me` memberships include `outlet_timezone`.

### Phase 5: payments, wallet, rewards, engagement, social

| Method & path | Who | Purpose |
|---|---|---|
| `GET /payments/config` | public | Whether Razorpay is set up on this server, and its public key id |
| `POST /payments/razorpay/checkout` | signed in | Create a Razorpay order for an unpaid order (amount read by the server) or a wallet top-up (₹50–₹5,000). `503 payments_unavailable` when Razorpay isn't configured |
| `POST /payments/razorpay/verify` | owner | Checkout callback: HMAC signature check, then capture (pays the order or credits the wallet). Idempotent |
| `POST /payments/razorpay/webhook` | Razorpay | Signed (`X-Razorpay-Signature`), de-duplicated by event id; same capture path |
| `GET /wallet` | signed in | Balance and ledger (cursor) |
| `POST /orders/{id}/pay-with-wallet` | owner | Debit and mark paid in one transaction; retry-safe. Not for group orders |
| `POST /orders/{id}/voucher` | owner | Apply your voucher to your unpaid order (server lowers the total) |
| `GET /loyalty`, `POST /loyalty/vouchers` | signed in | Points, tier, ledger, vouchers and rules (D-15); spend 100 points on a ₹10 voucher |
| `GET/PUT/DELETE /budget` | signed in | Monthly (and optional daily) limit; spend this month/today and by category |
| `GET /notifications`, `POST /notifications/read`, `POST/DELETE /notifications/push-tokens` | signed in | Notification Center (written only by database triggers), read state, Expo device tokens |
| `GET /outlets/{id}/specials` | public | Today's and upcoming specials with server prices and portions left |
| `GET /outlets/{id}/polls`, `GET /outlets/{id}/polls/my-votes`, `POST /polls/{id}/vote` | public / signed in | Live poll counts; one vote per student |
| `GET /outlets/{id}/reviews`, `GET /ratings` | public | Anonymous reviews (`needs_reply` filter) and the outlet leaderboard |
| `POST/GET /orders/{id}/review` | owner | Rate a collected order within 7 days (4 dimensions, +15 points) |
| `GET /popular` | signed in | Items at least 5 students ordered in 14 days (your department first, else campus) |
| `GET/POST /groups`, `POST /groups/join`, `GET /groups/{id}`, `PUT /groups/{id}/items`, `PUT /groups/{id}/split`, `POST /groups/{id}/checkout`, `POST /groups/{id}/pay`, `POST /groups/{id}/leave` | members | Group orders: shared tray, split by dish / equally / %, host checks out, each member pays their share from the wallet |
| `GET/POST /parties`, `POST /parties/{id}/pay`, `POST /parties/{id}/cancel` | signed in | Party (catering) bookings |
| `GET/POST /splits`, `POST /splits/{id}/settle`, `POST /splits/{id}/cancel` | participants | Bill splits settled by wallet transfer |
| `POST /staff/reviews/{id}/reply` | outlet staff | Reply as the outlet |
| `GET/PUT /manage/outlets/{id}/specials`, `DELETE /manage/specials/{id}` | manager | Specials (a new one for today notifies recent customers) |
| `POST /manage/outlets/{id}/polls`, `POST /manage/polls/{id}/close`, `POST /manage/polls/{id}/publish` | manager | Polls; publish a winner (default most votes) as the poll's special |
| `GET /manage/outlets/{id}/parties`, `POST /manage/parties/{id}/decision`, `POST /manage/parties/{id}/fulfil` | manager | Party bookings |

Payment confirmation by a client is impossible: only trusted server code (`app.capture_payment` after a verified
signature, `app.confirm_order_payment` for tests) or the wallet/group functions can mark an order paid, all through
`private.mark_order_paid`. Orders also carry `discount_paise`, `loyalty_points` (owner only) and `group_session_id`;
the menu and cart carry today's `special` price.

## Order lifecycle

```
payment_pending ──(verified payment, system)──► placed ──► confirmed ──► preparing ──► ready_for_pickup ──(pickup code)──► completed
     │ student cancel / reservation expiry          │ student cancel   │ staff cancel  │ staff cancel
     ▼                                              │ staff reject     ▼               ▼
 cancelled                                          ▼              cancelled       cancelled
                                            cancelled / rejected
```

Phase 4 adds two system-only moves: `ready_for_pickup → no_show` (not collected by the pickup deadline:
no refund, packaged items restocked, prepared items listed as a deal; `app.process_no_shows`, pg_cron every
minute) and `payment_pending → ready_for_pickup` (a paid surplus-deal order: the food is already at the counter).

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
| `deal_not_found` / `deal_unavailable` / `own_deal` | 404 / 409 / 409 | Unknown deal / already held, sold or ended / it came from your own uncollected order |
| `refund_not_allowed` / `refund_window_closed` / `refund_already_requested` / `refund_already_owed` / `no_show_not_refundable` | 409 | Refund request rules |
| `already_decided` / `refund_request_not_found` | 409 / 404 | Refund desk |
| `duplicate_name` / `invalid_price` / `category_not_found` / `invalid_hours` / `overlapping_hours` / `invalid_setting` | 409 / 422 | Menu, hours and settings validation |
| `capacity_below_reserved` / `slot_not_found` | 409 / 404 | Slot edits |
| `user_not_found` / `already_staff` / `staff_not_found` | 404 / 409 / 404 | Staff management |
| `payments_unavailable` / `invalid_signature` / `payment_not_found` | 503 / 422 / 404 | Online payment not set up / bad Razorpay signature / unknown payment |
| `insufficient_wallet_balance` / `invalid_topup_amount` / `wallet_limit` | 409 / 422 / 409 | Wallet |
| `not_enough_points` / `voucher_not_found` / `voucher_unavailable` / `voucher_already_applied` / `order_too_small` | 409 / 404 / 409 | Loyalty and vouchers |
| `special_portions_left` / `portions_below_sold` / `special_has_sales` | 409 | Specials |
| `poll_closed` / `already_voted` / `poll_published` | 409 | Polls |
| `review_not_allowed` / `review_window_closed` / `already_reviewed` | 409 | Reviews |
| `group_not_found` / `group_locked` / `group_full` / `group_empty` / `group_order` / `group_not_payable` | 404 / 409 / 422 | Group orders (`group_order`: pay the share instead) |
| `party_not_found` / `party_not_payable` / `party_too_late` / `invalid_event_time` | 404 / 409 / 422 | Party bookings |
| `participant_not_found` / `split_cancelled` | 422 / 409 | Bill splits |

## Realtime

Subscribe with Supabase Realtime (`postgres_changes`) using the user's access token. RLS applies per subscriber.

| Table | Who receives changes |
|---|---|
| `orders`, `order_events` | The order's owner; staff of its outlet (filter e.g. `outlet_id=eq.<id>`) |
| `outlets`, `menu_items`, `inventory`, `pickup_slots` | Anyone who can see the row (public catalogue) |
| `surplus_deals` | On-sale deals: anyone; all deals: the outlet's staff; a buyer: deals they hold or bought |
| `refund_requests` | The student who asked; the outlet's managers |
| `wallet_accounts`, `loyalty_accounts`, `notifications` | The owner only |
| `daily_specials`, `polls`, `poll_options` | Anyone (vote counts only, never who voted) |
| `group_sessions` | Group members (the row's `version` changes with every tray, member or share change) |

Not published: ledgers, payments, `group_items` (deletes would bypass RLS) and `reviews` (whole rows would expose
the reviewer).

Not published: carts (Realtime doesn't filter DELETE events by RLS), pickup codes, and the stock ledger. Clients must
refetch authoritative state on (re)connect and use `orders.version` to ignore stale or duplicate events.
