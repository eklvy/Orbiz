# ml/ — offline RL (Phases 6A–6B)

Everything here runs offline. Nothing in `ml/` is called by the API or apps; Phase 6C adds a separate, bounded
inference boundary (`services/intelligence/`).

**All data is SYNTHETIC** until the pilot produces real orders. Results are labelled as such and are never presented
as real-world improvements.

```bash
cd ml
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest -q
.venv/bin/python -m campuscart_ml.evaluate --episodes 200 --seed 0 \
  --kitchen-config configs/kitchen_default.json --out runs/baselines-200
```

| Path | What it is |
|---|---|
| `src/campuscart_ml/kitchen/` | **Kitchen Dispatcher**: Gymnasium environment (masked actions), config, baseline policies |
| `src/campuscart_ml/slots/` | **Slot Nudger**: contextual-bandit environment (masked actions), baseline policies |
| `src/campuscart_ml/evaluate.py` | Fixed-seed evaluation of baselines → `runs/<name>/results.{json,md}` |
| `configs/` | Versioned simulation configs |
| `REWARD_DESIGN.md` | Every reward term and assumption, with reasoning |
| `runs/`, `checkpoints/`, `artifacts/` | Git-ignored outputs |

Phase 6B adds training (PPO with action masking for the dispatcher, Thompson sampling for the nudger), compared
against these baselines on the same seeds. Phase 7 adds `demand_forecasting/`.
