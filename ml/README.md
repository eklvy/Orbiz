# ml/ (not yet implemented)

Offline ML and RL work. Planned layout (created in the phase that needs it):

- `ml/reinforcement_learning/kitchen_dispatcher/` — Gymnasium env, baselines, PPO training (Phases 6A–6B)
- `ml/reinforcement_learning/slot_nudger/` — contextual bandit (Thompson sampling), baselines (Phases 6A–6B)
- `ml/demand_forecasting/` — baselines then models, chronological splits (Phase 7)

Rules: fixed seeds, versioned configs, results only from real runs, synthetic data always labelled synthetic.
Checkpoints and run artefacts are git-ignored and tracked through the model registry tables.
