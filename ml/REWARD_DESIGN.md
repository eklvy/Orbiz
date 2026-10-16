# Reward design (Phase 6A)

Both advisors are trained and compared in **synthetic** simulations: we have no real order history yet. Every number
below is an assumption, chosen to be explainable, and lives in a versioned config (`ml/configs/`,
`campuscart_ml/*/config.py`). When the pilot produces real orders, the simulators are re-fitted and the results
re-run; until then no result may be presented as a real-world improvement.

Both environments only let the advisor choose among **valid actions** (`action_masks()`), the same rule production
follows: an advisor can never start an order that isn't waiting, or suggest a slot that is full or doesn't exist.

## Kitchen Dispatcher (`KitchenDispatchEnv`)

**What it decides:** when a cooking station is free and orders are waiting, which waiting order to start next — or
to wait one minute (so cooking can be timed to the pickup slot, as the report describes).

**What the simulation models (one lunch service, 180 minutes):**

| Element | Assumption | Why |
|---|---|---|
| Stations | 2 orders cook in parallel | `outlets.concurrent_orders` default |
| Arrivals | Poisson, 0.25 → 0.55 (lunch peak, minutes 40–100) → 0.3 → 0.15 orders/min | A busy cafe with a peak that briefly overloads 2 stations |
| Pickup slot | First slot the kitchen could make (50%), or 1–3 slots later (25/15/10%) | Students order “now” or for a later class break |
| Prep time | 2–8 min nominal (the order's longest item), actual = nominal × lognormal(σ = 0.2) | Kitchens aren't perfectly predictable; the advisor sees only the nominal time |
| Visible queue | Oldest 12 waiting orders | Fixed action space; 12 covers almost all states |

**Reward, paid when an order becomes ready (units: roughly “minutes of student time”):**

| Term | Value | Reasoning |
|---|---|---|
| On time (ready by slot start) | **+1** | Small positive signal for doing the job |
| Each minute late after slot start | **−1** | The student is standing at the counter |
| Each minute after the slot has ended | **−2 extra** | The student has likely left for class; much worse than being a bit late |
| Each minute ready more than 10 min before the slot | **−0.2** | Food cools; tolerance of 10 min is free |
| Each order unfinished when the service is cut off (60 min after arrivals stop) | **−30** | Never acceptable; stops a policy from “parking” orders |

Lateness dominates freshness on purpose: a cold meal is bad, a missed class is worse.

**Baselines (yardsticks for Phase 6B):** FIFO, shortest prep first, earliest pickup slot first (EDD), least slack
first (slot start − prep), and a just-in-time rule (least slack, but hold food back when the kitchen is quiet and
there is plenty of slack).

## Slot Nudger (`SlotNudgeEnv`)

**What it decides:** at checkout, whether to suggest one alternative pickup slot (up to ±2 slots, only slots with
space) or to suggest nothing. It is a contextual bandit: one decision per checkout, immediate reward.

**What the simulation models (one service, 16 slots × 10 orders, 80 checkouts):** requested slots cluster around a
lunch peak (Normal, mean slot 7, sd 2.5). A student accepts a suggestion with probability
`sigmoid(flexibility − 1.0 × slots moved)`, where `flexibility ~ Normal(0.5, 1.0)` is hidden from the advisor
(about 30% accept a 1-slot move).

**Reward per checkout:**

| Term | Value | Reasoning |
|---|---|---|
| Crowding saved | `utilisation(requested)² − utilisation(chosen)²` after booking | Squared, so relieving a nearly full slot matters much more than a quiet one |
| Showing any suggestion | **−0.05** | Prompts annoy students; nudging everyone should not pay |
| Each slot (15 min) moved | **−0.05** | Bigger moves are a bigger ask |
| No suggestion | **0** | Neutral |

**Baselines:** never nudge, random valid slot, least-loaded slot, and a threshold rule (nudge only when the requested
slot is ≥ 70% full, to the nearest slot under 50%, preferring later).

## Results so far

Baseline numbers come only from real runs of `python -m campuscart_ml.evaluate` and are recorded, with seeds, in
`docs/IMPLEMENTATION_STATUS.md` (Phase 6A).

## Open questions for the team

- Is −1 per late minute vs −0.2 per early minute the right balance between waiting students and cooling food?
- Should being late past the end of the slot cost even more?
- What's an acceptable number of nudges per student per week before it becomes annoying?
