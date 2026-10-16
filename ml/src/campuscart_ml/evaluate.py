"""Evaluate baseline policies on the SYNTHETIC environments with fixed seeds.

    python -m campuscart_ml.evaluate --episodes 200 --seed 0 --out runs/baselines

Writes `results.json` (config, seeds, per-policy metric means with 95% confidence intervals) and
`results.md` (a table). Results are only ever reported from real runs of this script.
"""

import argparse
import json
import platform
import time
from collections.abc import Callable, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np

from campuscart_ml.kitchen import baselines as kitchen_baselines
from campuscart_ml.kitchen.config import KitchenConfig
from campuscart_ml.kitchen.env import KitchenDispatchEnv
from campuscart_ml.slots import baselines as slot_baselines
from campuscart_ml.slots.env import SlotNudgeConfig, SlotNudgeEnv


def run_episode(
    env: gym.Env[Any, int], policy: Callable[[Any], int], seed: int
) -> dict[str, float]:
    env.reset(seed=seed)
    while True:
        _, _, terminated, truncated, info = env.step(policy(env))
        if terminated or truncated:
            metrics: dict[str, float] = info["metrics"]
            return metrics


def summarise(rows: Sequence[dict[str, float]]) -> dict[str, dict[str, float]]:
    """Mean and a normal-approximation 95% confidence interval per metric."""
    out: dict[str, dict[str, float]] = {}
    for key in rows[0]:
        values = np.array([r[key] for r in rows], dtype=float)
        half = 1.96 * values.std(ddof=1) / np.sqrt(len(values)) if len(values) > 1 else 0.0
        out[key] = {"mean": float(values.mean()), "ci95": float(half)}
    return out


def evaluate(
    episodes: int, seed: int, kitchen: KitchenConfig, slots: SlotNudgeConfig
) -> dict[str, Any]:
    seeds = [seed + i for i in range(episodes)]
    results: dict[str, Any] = {
        "synthetic": True,
        "episodes": episodes,
        "seeds": [seeds[0], seeds[-1]],
        "python": platform.python_version(),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kitchen": {"config": asdict(kitchen), "policies": {}},
        "slots": {"config": slots.to_dict(), "policies": {}},
    }
    for name, policy in kitchen_baselines.POLICIES.items():
        env = KitchenDispatchEnv(kitchen)
        rows = [run_episode(env, policy, s) for s in seeds]
        results["kitchen"]["policies"][name] = summarise(rows)
    for name, slot_policy in slot_baselines.POLICIES.items():
        slot_env = SlotNudgeEnv(slots)
        rows = [run_episode(slot_env, slot_policy, s) for s in seeds]
        results["slots"]["policies"][name] = summarise(rows)
    return results


def to_markdown(results: dict[str, Any]) -> str:
    def table(section: str, columns: list[tuple[str, str, str]]) -> list[str]:
        head = "| Policy | " + " | ".join(label for label, _, _ in columns) + " |"
        lines = [head, "|" + "---|" * (len(columns) + 1)]
        for name, metrics in results[section]["policies"].items():
            cells = []
            for _, key, fmt in columns:
                m = metrics[key]
                cells.append(f"{m['mean']:{fmt}} ± {m['ci95']:{fmt}}")
            lines.append(f"| {name} | " + " | ".join(cells) + " |")
        return lines

    lines = [
        f"_SYNTHETIC simulation, {results['episodes']} episodes per policy, seeds "
        f"{results['seeds'][0]}-{results['seeds'][1]}, generated {results['generated_at']}. "
        "Mean ± 95% CI._",
        "",
        "**Kitchen Dispatcher baselines**",
        "",
        *table(
            "kitchen",
            [
                ("On time", "on_time_rate", ".1%"),
                ("Mean late (min)", "mean_lateness_min", ".2f"),
                ("p95 late (min)", "p95_lateness_min", ".1f"),
                ("After slot end", "very_late_rate", ".1%"),
                ("Ready too early (min)", "mean_early_excess_min", ".2f"),
                ("Reward", "total_reward", ".0f"),
            ],
        ),
        "",
        "**Slot Nudger baselines**",
        "",
        *table(
            "slots",
            [
                ("Peak utilisation", "peak_utilisation", ".2f"),
                ("Slots > 80%", "slots_over_80pct", ".2f"),
                ("Nudge rate", "nudge_rate", ".1%"),
                ("Accepted", "acceptance_rate", ".1%"),
                ("Mean shift (slots)", "mean_shift_slots", ".2f"),
                ("Reward", "total_reward", ".2f"),
            ],
        ),
    ]
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--episodes", type=int, default=200)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--kitchen-config", type=Path)
    parser.add_argument("--out", type=Path, default=Path("runs/baselines"))
    args = parser.parse_args(argv)
    kitchen = (
        KitchenConfig.from_json(args.kitchen_config) if args.kitchen_config else KitchenConfig()
    )
    results = evaluate(args.episodes, args.seed, kitchen, SlotNudgeConfig())
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "results.json").write_text(json.dumps(results, indent=2))
    (args.out / "results.md").write_text(to_markdown(results))
    print(to_markdown(results))


if __name__ == "__main__":
    main()
