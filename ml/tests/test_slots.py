"""Slot Nudger environment: masks, capacity, determinism, reward formula, baselines."""

import numpy as np
import pytest

from campuscart_ml.slots import baselines
from campuscart_ml.slots.env import SlotNudgeConfig, SlotNudgeEnv


def run(env: SlotNudgeEnv, policy: baselines.Policy, seed: int) -> dict[str, float]:
    env.reset(seed=seed)
    while True:
        action = policy(env)
        assert env.action_masks()[action], f"{policy.__name__} chose a masked action"
        obs, _, terminated, truncated, info = env.step(action)
        assert env.observation_space.contains(obs)
        assert (env._reserved <= env.config.capacity).all()
        if terminated or truncated:
            metrics: dict[str, float] = info["metrics"]
            return metrics


def test_masks_follow_slot_range_and_capacity() -> None:
    env = SlotNudgeEnv(SlotNudgeConfig(slots=4, capacity=1, peak_slot=0, peak_spread=0.01))
    env.reset(seed=0)
    assert env.requested_slot == 0
    mask = env.action_masks()
    assert mask[0], "no nudge is always allowed"
    for j, offset in enumerate(env.offsets):
        assert mask[1 + j] == (0 <= offset < 4)
    env._reserved[1] = 1
    assert not env.action_masks()[1 + env.offsets.index(1)]
    with pytest.raises(ValueError, match="not valid"):
        env.step(1 + env.offsets.index(-1))


def test_never_nudge_earns_nothing_and_moves_nobody() -> None:
    metrics = run(SlotNudgeEnv(), baselines.never_nudge, 0)
    assert metrics["total_reward"] == 0.0
    assert metrics["mean_shift_slots"] == 0.0
    assert metrics["bookings"] == SlotNudgeConfig().requests


def test_reward_formula_when_the_student_accepts() -> None:
    config = SlotNudgeConfig(flexibility_mean=50.0, flexibility_sd=0.0)  # always accepts
    env = SlotNudgeEnv(config)
    env.reset(seed=0)
    requested = env.requested_slot
    env._reserved[requested] = 6
    action = 1 + env.offsets.index(1)
    _, reward, _, _, info = env.step(action)
    w = config.rewards
    expected = (7 / 10) ** 2 - (1 / 10) ** 2 - w.nudge_shown_cost - w.shift_cost_per_slot
    assert info["accepted"] and info["slot"] == requested + 1
    assert reward == pytest.approx(expected)


def test_a_rejected_nudge_only_costs_the_annoyance() -> None:
    config = SlotNudgeConfig(flexibility_mean=-50.0, flexibility_sd=0.0)  # never accepts
    env = SlotNudgeEnv(config)
    env.reset(seed=0)
    _, reward, _, _, info = env.step(1 + env.offsets.index(2))
    assert not info["accepted"]
    assert reward == pytest.approx(
        -(config.rewards.nudge_shown_cost + 2 * config.rewards.shift_cost_per_slot)
    )


def test_same_seed_same_episode() -> None:
    assert run(SlotNudgeEnv(), baselines.random_valid, 5) == run(
        SlotNudgeEnv(), baselines.random_valid, 5
    )


@pytest.mark.parametrize("name", sorted(baselines.POLICIES))
def test_baselines_only_choose_valid_actions(name: str) -> None:
    for seed in range(3):
        run(SlotNudgeEnv(), baselines.POLICIES[name], seed)


def test_nudging_to_quieter_slots_reduces_crowding() -> None:
    seeds = range(20)
    never = [run(SlotNudgeEnv(), baselines.never_nudge, s)["slots_over_80pct"] for s in seeds]
    spread = [run(SlotNudgeEnv(), baselines.least_loaded, s)["slots_over_80pct"] for s in seeds]
    assert np.mean(spread) < np.mean(never)
