# services/intelligence (not yet implemented)

Python service boundary for model **inference** (Kitchen Dispatcher PPO, Slot Nudger bandit,
demand forecasts, BiteBot tool layer). Training code lives in `ml/` and never runs on the request path.

- Phase 6A/6B: environments, training, evaluation (`ml/`).
- Phase 6C: bounded inference with timeouts, validation, feature flags, deterministic fallbacks.
- Phase 7: forecasting, BiteBot, Surprise Meal.

Whether this is a separate process or a module inside `services/api` is decided in Phase 6C
based on measured inference latency and model size (see docs/ARCHITECTURE.md §10).
