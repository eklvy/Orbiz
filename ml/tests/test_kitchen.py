"""Kitchen Dispatcher environment: API contract, determinism, invariants, reward accounting,
masking, and that the baselines behave as scheduling theory expects."""

import dataclasses
import json
from pathlib import Path

import numpy as np
import pytest
from gymnasium.spaces import Discrete

from campuscart_ml.kitchen import baselines
from campuscart_ml.kitchen.config import KitchenConfig, KitchenRewardWeights
from campuscart_ml.kitchen.env import KitchenDispatchEnv, Order


def run(
    env: KitchenDispatchEnv, policy: baselines.Policy, seed: int
) -> tuple[float, dict[str, float]]:
    env.reset(seed=seed)
    total = 0.0
    while True:
        mask = env.action_masks()
        action = policy(env)
        assert mask[action], f"{policy.__name__} chose a masked action"
        assert len(env._running) <= env.config.stations
        obs, reward, terminated, truncated, info = env.step(action)
        assert env.observation_space.contains(obs)
        total += reward
        if terminated or truncated:
            return total, info["metrics"]


def test_spaces_and_reset() -> None:
    env = KitchenDispatchEnv()
    obs, info = env.reset(seed=1)
    assert env.observation_space.contains(obs)
    assert info == {"synthetic": True}
    assert isinstance(env.action_space, Discrete)
    assert env.action_space.n == env.config.queue_window + 1


def test_same_seed_same_episode_and_different_seeds_differ() -> None:
    a, b = KitchenDispatchEnv(), KitchenDispatchEnv()
    _, ma = run(a, baselines.fifo, 7)
    _, mb = run(b, baselines.fifo, 7)
    assert ma == mb
    _, mc = run(a, baselines.fifo, 8)
    assert mc != ma


def test_every_order_is_accounted_for_and_reward_adds_up() -> None:
    env = KitchenDispatchEnv()
    total, metrics = run(env, baselines.least_slack_first, 3)
    assert metrics["finished"] + metrics["unfinished"] == metrics["orders"] > 0
    assert total == pytest.approx(metrics["total_reward"])
    # Recompute the reward from the finished orders with the documented formula.
    w = env.config.rewards
    expected = 0.0
    for order in env._orders:
        assert order.ready is not None and order.started is not None
        assert order.started >= order.arrival
        assert order.ready == pytest.approx(order.started + order.prep_actual)
        late = max(0.0, order.ready - order.slot_start)
        very = max(0.0, order.ready - order.slot_end)
        early = max(0.0, order.slot_start - env.config.early_tolerance_minutes - order.ready)
        expected += (w.on_time_bonus if late == 0 else 0) - w.late_per_minute * late
        expected -= w.very_late_per_minute * very + w.early_per_minute * early
    assert total == pytest.approx(expected)


def test_masks_and_invalid_actions() -> None:
    env = KitchenDispatchEnv()
    env.reset(seed=0)
    mask = env.action_masks()
    waiting = min(len(env.visible_queue()), env.config.queue_window)
    assert mask[:waiting].all() and not mask[waiting : env.config.queue_window].any()
    assert mask[env.wait_action] == (waiting > 0)
    invalid = int(np.flatnonzero(~mask)[0])
    with pytest.raises(ValueError, match="not valid"):
        env.step(invalid)


def test_wait_moves_the_clock_without_starting_anything() -> None:
    env = KitchenDispatchEnv()
    env.reset(seed=0)
    before = (env.now, len(env.visible_queue()))
    env.step(env.wait_action)
    assert env.now >= before[0] + env.config.wait_minutes - 1e-9
    assert len(env.visible_queue()) >= before[1]


def test_reward_formula_per_order() -> None:
    env = KitchenDispatchEnv(KitchenConfig(rewards=KitchenRewardWeights()))
    env.reset(seed=0)

    def score(ready: float) -> float:
        order = Order(999, 0.0, 30.0, 45.0, 5.0, 5.0, started=ready - 5.0)
        env._stats.busy_minutes = 0
        return env._complete(order, ready)

    assert score(25.0) == pytest.approx(1.0)  # on time, within the 10-minute freshness window
    assert score(33.0) == pytest.approx(-3.0)  # 3 minutes late
    assert score(50.0) == pytest.approx(-20.0 - 2.0 * 5.0)  # 20 late, 5 past the slot end
    assert score(10.0) == pytest.approx(1.0 - 0.2 * 10.0)  # ready 20 min early: 10 beyond tolerance


def test_overloaded_kitchen_is_cut_off_with_a_penalty() -> None:
    config = KitchenConfig(
        stations=1, arrival_profile=((0, 2.0),), service_minutes=60, overtime_minutes=0
    )
    env = KitchenDispatchEnv(config)
    _, metrics = run(env, baselines.fifo, 0)
    assert metrics["unfinished"] > 0
    assert metrics["finished"] + metrics["unfinished"] == metrics["orders"]


@pytest.mark.parametrize("name", sorted(baselines.POLICIES))
def test_baselines_only_choose_valid_actions(name: str) -> None:
    env = KitchenDispatchEnv()
    for seed in range(3):
        run(env, baselines.POLICIES[name], seed)


def test_due_date_ordering_beats_first_come_first_served_on_lateness() -> None:
    """EDD minimises maximum lateness in theory; over many seeds it should be at least as good."""
    env = KitchenDispatchEnv()
    seeds = range(20)
    fifo = [run(env, baselines.fifo, s)[1]["mean_lateness_min"] for s in seeds]
    edd = [run(env, baselines.earliest_due_first, s)[1]["mean_lateness_min"] for s in seeds]
    assert np.mean(edd) < np.mean(fifo)


def test_config_round_trips_through_json(tmp_path: Path) -> None:
    config = KitchenConfig(stations=3, rewards=KitchenRewardWeights(late_per_minute=2.0))
    path = tmp_path / "kitchen.json"
    path.write_text(config.to_json())
    assert KitchenConfig.from_json(path) == config
    assert json.loads(config.to_json())["rewards"]["late_per_minute"] == 2.0
    with pytest.raises(ValueError):
        dataclasses.replace(config, stations=0)
