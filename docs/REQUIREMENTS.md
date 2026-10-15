# CampusCart — Requirements Traceability

Sources:

- **[R]** `CampusCart_Team_Orbiz_Report.pdf/.docx`: Team Orbiz report (Eklavya, Himanshi, Bhavya Tiwari), NCU August 2026 Innovation Challenge.
- **[P]** The master build prompt (implementation contract).

The report describes a prototype and marks features "Done". This repository is a **from-scratch
rebuild**, so nothing below is implemented unless [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) says so.
Figures quoted in the report (e.g. "40+ features", "1.2-minute refund resolution", "4.8/5 rating",
"850 pts", the student testimonial) are prototype or demo values. They are **not** requirements and will not
be seeded or displayed as real data.

## 1. Feature map

| # | Feature | Source | Phase |
|---|---|---|---|
| F1 | One student account across app and website; separate manager login; managers see only their outlets | R, P | 1 |
| F2 | Register with Student ID / roll number, name, campus email, department, year (web also: hostel room) | R | 1, 3 |
| F3 | Outlet list with current wait time (and free seats, see D-2) | R | 2–3 |
| F4 | Menu browse with meal-type, diet and price filters; search; item details | R, P | 2–3 |
| F5 | Pickup slot selection ("Now" or a later slot); kitchen times prep to the slot | R, P | 2–3 |
| F6 | Live order tracking: status timeline, queue position ("orders ahead"), live countdown | R | 2–3 |
| F7 | Digital token (e.g. `A-24`) + QR "Digital Campus Food Pass" with counter, ETA, itemised bill | R | 2–4 |
| F8 | Same cart across devices (server-side cart) | R | 2–3 |
| F9 | Order history with token, group tag, status, bill, calories, points earned | R | 3 |
| F10 | Cafe status: Open / Take a Break (preset duration + public reason) / Close; new orders blocked when not open; fleet status view | R | 2, 4 |
| F11 | Refunds & cancellations desk: approve/decline, bulk approve pending, audit trail | R, P | 4–5 |
| F12 | Daily specials with live portion counters and discount %; polls for tomorrow's special (one vote per student, live %); manager publishes the winner (manager decides) | R | 5 |
| F13 | Live kitchen queue; advance to Ready for Pickup (manager view + separate POS/kitchen app, see D-7) | R, P | 4 |
| F14 | Menu & stock control: Available / Low / Sold Out, instant sync, daily order count per item | R, P | 4 |
| F15 | Demand forecast: portions per dish for tomorrow, confidence, reasoning; hourly demand / peak hours | R, P | 7 |
| F16 | Reviews: 4 dimensions (taste, hygiene, speed, value); +15 loyalty points; chef replies; outlet leaderboard (Campus Feed); "needs reply" filter | R | 5 |
| F17 | Group order: shared tray, per-member items and paid status, add for a member, split by dish / equally / percentage | R, P | 5 |
| F18 | Party sessions (pre-booked catering for events) | R | 5 |
| F19 | Informal bill splits (settle shared expenses) | R | 5 |
| F20 | Wallet: balance, recharge, transactions; perks (1-tap group pay, auto-refunds) | R, P | 5 |
| F21 | Loyalty: tiers (e.g. Gold), redeemable vouchers; **+50 points for a single wallet recharge ≥ ₹999** | R | 5 |
| F22 | Budget planner: monthly limit, warnings before overspending; daily spend; category breakdown | R | 5 |
| F23 | Notification Center: categories Tokens & Orders, Crowd & Queue, Flash Specials (+ loyalty, stock); unread count | R, P | 5 |
| F24 | BiteBot chat assistant grounded in live canteen data | R, P | 7 |
| F25 | Surprise Meal: budget cap + craving mood (Quick Bite, High Protein, Cafe & Treat, Campus Feast) → combo within budget with price/calorie/protein breakdown; web shows price breakdown + per-dish swap | R | 7 |
| F26 | "Popular with your classmates" / Majority Choice banner | R | 5/7 (see D-9) |
| F27 | Live crowd & seating intelligence; "best time to visit" | R | see D-2 |
| F28 | RL Kitchen Dispatcher (PPO) | P | 6A–6C |
| F29 | RL Slot Nudger (contextual bandit, Thompson sampling) | P | 6A–6C |
| F30 | RL Insights in the manager dashboard | P | 6C |
| F31 | Payments via Razorpay (test mode in development), signed webhooks, idempotency | P | 5 |
| F32 | Separate POS/kitchen dashboard (fourth interface) | P | 4 |

## 2. Conflicts and decisions

**Status key:** `DECIDED` means resolved in this document. `OPEN` means it needs a product owner decision before
the phase noted, and the default shown is what will be built if no answer arrives.

| ID | Topic | Report says | Prompt says | Status / resolution |
|---|---|---|---|---|
| D-1 | RL Campus Navigator & 2D campus map with walking routes | Core feature on app and web | Explicitly out of scope | **DECIDED: excluded.** No navigation code, no "Navigate" buttons. |
| D-2 | Live seat detection / per-seat maps / crowd sensing | "Live seat detector" per outlet | `seat_occupancy` only "if supported by source requirements" | **DEFAULT IMPLEMENTED (Phase 2), still open to change.** No sensor or data source exists. Default: *crowd level derived from real order/queue load*, labelled as such, and no seat counts unless staff enter them manually. Real seat sensing needs hardware we don't have. |
| D-3 | Tap-to-enter with RFID campus card / gate QR | Login method | Not mentioned | **OPEN (before Phase 3).** Needs card data integration with the university. Default: not built; email/ID + password only. |
| D-4 | Guest mode with Guest Pass | Feature | Not mentioned | **DEFAULT IMPLEMENTED (Phase 1), still open to change.** Default: no guest ordering (identity, payments and abuse controls get harder). Public menu browsing without login is allowed. |
| D-5 | Faculty login | Demo roles Student/Faculty/Manager | Roles: student, manager, kitchen staff, admin | **DECIDED:** faculty are customers. `customer_type ∈ {student, faculty}` on the profile, same permissions as students. |
| D-6 | ₹500 signup bonus credited to wallet | Shown on registration | Financial records must be auditable | **OPEN (before Phase 5).** This is real money owed by someone. Default: not credited; can be enabled later as an auditable promotional ledger entry with a funding source. |
| D-7 | Kitchen queue location | Inside manager console (3 interfaces) | Separate POS/kitchen app (4 interfaces) | **DECIDED:** both. POS app is the operational queue; manager dashboard has the same live queue for oversight. One backend state machine serves both. |
| D-8 | Demand forecast inputs | "Trained on semester timetable and weather data" | Use only reliable available data; no claims without data | **DECIDED:** forecasts use order history (+ specials/time features). Timetable and weather are added only if a real data source is provided. Confidence and "reasoning" come from the model, not template text. |
| D-9 | "Popular with your classmates" (by department) | Feature | Privacy: don't leak other students' data | **DECIDED (design):** aggregate counts only, with a minimum-group threshold (k ≥ 5) before showing department-level stats. Phase 5/7. |
| D-10 | Login identifier | Student ID / roll number + password | Supabase Auth | **DEFAULT IMPLEMENTED (Phase 1), still open to change.** Supabase Auth uses email. Default: sign in with campus email + password; roll number stored on the profile and unique. Roll-number login would need a server-side lookup with rate limiting (enumeration risk). |
| D-11 | Allowed email domain | "Campus email" | Not specified | **DEFAULT IMPLEMENTED (Phase 1).** `private.allowed_email_domains`, empty locally (any domain). Still need the real domain(s) for the pilot. |
| D-12 | Stock model | Toggle Available / Low / Sold Out | Quantitative stock, prevent overselling | **IMPLEMENTED (Phase 2):** per item, `track_quantity` (true: decremented transactionally, `Low` derived from a threshold) or false (manual status only). A manual Sold Out always wins. |
| D-13 | "Simulate Alert" / Queue & Token Simulator demo controls | Shown in report screenshots | No fake data in operational UIs | **DECIDED:** not in production UIs. Dev-only tooling at most, clearly labelled. |
| D-14 | Outlets and menu catalogue | Mentions B Canteen, North Cafeteria, Ice Parlour, "all 5 outlets", 17 menu items | No fabricated records | **OPEN (needed before a pilot).** Phase 1 dev seeds are fictional. Need the real outlet list and menus. Default: dev seeds use obviously fictional sample data, local/test only. |
| D-15 | Loyalty earning rules beyond the two stated | +50 for recharge ≥ ₹999, +15 per review | Explicit earning/redemption policy required | **OPEN (before Phase 5).** Points per ₹ spent, tier thresholds, voucher catalogue and point value need a product decision. |
| D-16 | Poll subsidy | "20% subsidy promised on the winning dish" | No invented discounts | **DECIDED:** discount is a manager-configured field on the poll/special, not hardcoded. |
| D-17 | Wait-time estimate | Shown before ordering + countdown | — | **IMPLEMENTED (Phase 2):** Phase 2 gives a transparent estimate from queue length × configured prep times. Phase 6+ may improve it; any model-based estimate is labelled. |
| D-18 | Pay at the counter (cash/UPI on pickup) | Not described; report only shows online wallet/payments | Never mark orders paid without verification | **OPEN (before Phase 5).** Default: no counter payment. An order becomes `placed` only through verified payment (`app.confirm_order_payment`). A counter option would need staff-confirmed payment with an audit trail. |
| D-19 | No-show: food ready but never collected | Not described | Explicit order policy | **DECIDED (2026-10-14, product owner), implemented in Phase 4.** Deadline = later of "ready" and "slot end" + 15 min (outlet setting). No refund. Packaged items (per-item manager flag) return to stock; prepared items become one deal at 50% of what was paid, listed 30 min, then recorded unsold. A bought deal goes straight to `ready_for_pickup` with a new token/owner shown at the counter. Mixed orders split per item. Deal orders are not relisted. The original student can't buy their own deal. |
