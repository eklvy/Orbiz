"""Kitchen Dispatcher environment (Gymnasium), SYNTHETIC data.

A discrete-event simulation of one outlet's lunch service. Orders arrive with a pickup slot and a
nominal prep time; `stations` orders cook in parallel. The agent decides only when a station is
free and orders are waiting: it starts one of the visible waiting orders, or waits one minute (so
a policy can time cooking to the pickup slot, as the report describes). Invalid choices are masked
(`action_masks()`), matching the production rule that an advisor only picks among valid actions.

Reward (ml/REWARD_DESIGN.md) is paid when an order becomes ready; unfinished orders are penalised
when the episode is cut off.
"""

import heapq
import math
from dataclasses import dataclass, field
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from campuscart_ml.kitchen.config import KitchenConfig

FEATURES_PER_ORDER = 5
GLOBAL_FEATURES = 4


@dataclass
class Order:
    order_id: int
    arrival: float
    slot_start: float
    slot_end: float
    prep_nominal: float
    prep_actual: float
    started: float | None = None
    ready: float | None = None


@dataclass(frozen=True)
class OrderView:
    """What a policy may see about a waiting order (never the actual prep time)."""

    index: int  # action that starts this order
    order_id: int
    arrival: float
    slot_start: float
    slot_end: float
    prep_nominal: float


@dataclass
class EpisodeStats:
    rewards: list[float] = field(default_factory=list)
    lateness: list[float] = field(default_factory=list)
    early_excess: list[float] = field(default_factory=list)
    waits: list[float] = field(default_factory=list)
    on_time: int = 0
    very_late: int = 0
    unfinished: int = 0
    busy_minutes: float = 0.0


class KitchenDispatchEnv(gym.Env[np.ndarray, int]):
    metadata: dict[str, Any] = {"render_modes": []}  # noqa: RUF012

    def __init__(self, config: KitchenConfig | None = None) -> None:
        super().__init__()
        self.config = config or KitchenConfig()
        k = self.config.queue_window
        self.wait_action = k
        self.action_space: spaces.Discrete = spaces.Discrete(  # type: ignore[assignment]
            k + 1
        )
        size = k * FEATURES_PER_ORDER + GLOBAL_FEATURES
        self.observation_space = spaces.Box(low=-10.0, high=10.0, shape=(size,), dtype=np.float32)
        self._orders: list[Order] = []
        self._pending: list[Order] = []  # not yet arrived, sorted by arrival
        self._queue: list[Order] = []  # arrived, waiting to start (arrival order)
        self._running: list[tuple[float, int]] = []  # heap of (ready time, order id)
        self._now = 0.0
        self._stats = EpisodeStats()

    # --- Gymnasium API ------------------------------------------------------------------------

    def reset(
        self, *, seed: int | None = None, options: dict[str, Any] | None = None
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        self._orders = self._generate_orders()
        self._pending = list(self._orders)
        self._queue = []
        self._running = []
        self._now = 0.0
        self._stats = EpisodeStats()
        reward = self._advance()
        self._stats.rewards.append(reward)
        return self._observation(), {"synthetic": True}

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        if not self.action_masks()[action]:
            raise ValueError(f"action {action} is not valid now (use action_masks())")
        reward = 0.0
        if action == self.wait_action:
            reward += self._advance(until=self._now + self.config.wait_minutes)
        else:
            self._start(self._queue[action])
            reward += self._advance()
        terminated = self._finished()
        truncated = not terminated and self._now >= self._cutoff()
        if truncated:
            reward += self._cut_off()
        self._stats.rewards.append(reward)
        info: dict[str, Any] = {"synthetic": True}
        if terminated or truncated:
            info["metrics"] = self.metrics()
        return self._observation(), reward, terminated, truncated, info

    def action_masks(self) -> np.ndarray:
        """Valid actions now: start any visible waiting order, or wait (while orders wait)."""
        mask = np.zeros(self.config.queue_window + 1, dtype=bool)
        mask[: min(len(self._queue), self.config.queue_window)] = True
        mask[self.wait_action] = bool(self._queue)
        return mask

    # --- What policies may see ----------------------------------------------------------------

    @property
    def now(self) -> float:
        return self._now

    def visible_queue(self) -> list[OrderView]:
        return [
            OrderView(i, o.order_id, o.arrival, o.slot_start, o.slot_end, o.prep_nominal)
            for i, o in enumerate(self._queue[: self.config.queue_window])
        ]

    def metrics(self) -> dict[str, float]:
        s = self._stats
        finished = len(s.lateness)
        total = len(self._orders)
        late = np.array(s.lateness) if s.lateness else np.zeros(1)
        return {
            "orders": float(total),
            "finished": float(finished),
            "unfinished": float(s.unfinished),
            "on_time_rate": s.on_time / total if total else 1.0,
            "very_late_rate": s.very_late / total if total else 0.0,
            "mean_lateness_min": float(np.mean(late)),
            "p95_lateness_min": float(np.percentile(late, 95)),
            "max_lateness_min": float(np.max(late)),
            "mean_early_excess_min": float(np.mean(s.early_excess)) if s.early_excess else 0.0,
            "mean_wait_to_start_min": float(np.mean(s.waits)) if s.waits else 0.0,
            "utilisation": s.busy_minutes / (self.config.stations * max(self._now, 1.0)),
            "total_reward": float(sum(s.rewards)),
        }

    # --- Simulation ---------------------------------------------------------------------------

    def _generate_orders(self) -> list[Order]:
        cfg = self.config
        rng = self.np_random
        orders: list[Order] = []
        weights = np.array(cfg.prep_weights) / sum(cfg.prep_weights)
        extra = np.array(cfg.extra_slot_weights) / sum(cfg.extra_slot_weights)
        boundaries = [start for start, _ in cfg.arrival_profile] + [cfg.service_minutes]
        t = 0.0
        for (start, rate), end in zip(cfg.arrival_profile, boundaries[1:], strict=True):
            t = float(start)
            while rate > 0:
                t += float(rng.exponential(1.0 / rate))
                if t >= end:
                    break
                prep = float(rng.choice(cfg.prep_minutes, p=weights))
                earliest = t + prep
                slot = math.ceil(earliest / cfg.slot_minutes) * cfg.slot_minutes
                slot += int(rng.choice(len(extra), p=extra)) * cfg.slot_minutes
                actual = prep * float(rng.lognormal(0.0, cfg.prep_noise_sigma))
                orders.append(
                    Order(len(orders), t, float(slot), float(slot + cfg.slot_minutes), prep, actual)
                )
        return orders

    def _cutoff(self) -> float:
        return float(self.config.service_minutes + self.config.overtime_minutes)

    def _finished(self) -> bool:
        return not self._pending and not self._queue and not self._running

    def _start(self, order: Order) -> None:
        self._queue.remove(order)
        order.started = self._now
        self._stats.waits.append(self._now - order.arrival)
        heapq.heappush(self._running, (self._now + order.prep_actual, order.order_id))

    def _complete(self, order: Order, at: float) -> float:
        cfg, w = self.config, self.config.rewards
        order.ready = at
        assert order.started is not None  # noqa: S101
        self._stats.busy_minutes += at - order.started
        lateness = max(0.0, at - order.slot_start)
        very_late = max(0.0, at - order.slot_end)
        early_excess = max(0.0, order.slot_start - cfg.early_tolerance_minutes - at)
        self._stats.lateness.append(lateness)
        self._stats.early_excess.append(early_excess)
        if lateness == 0:
            self._stats.on_time += 1
        if very_late > 0:
            self._stats.very_late += 1
        return (
            (w.on_time_bonus if lateness == 0 else 0.0)
            - w.late_per_minute * lateness
            - w.very_late_per_minute * very_late
            - w.early_per_minute * early_excess
        )

    def _needs_decision(self) -> bool:
        return bool(self._queue) and len(self._running) < self.config.stations

    def _advance(self, until: float | None = None) -> float:
        """Moves time forward, processing arrivals and completions, until a decision is needed
        (a free station and a waiting order) — or, for a wait, until `until` passes."""
        reward = 0.0
        while True:
            if until is None and self._needs_decision():
                return reward
            next_arrival = self._pending[0].arrival if self._pending else math.inf
            next_ready = self._running[0][0] if self._running else math.inf
            nxt = min(next_arrival, next_ready)
            if until is not None and until <= nxt:
                self._now = max(self._now, until)
                # After a wait, keep going only if no decision is possible.
                until = None
                if self._needs_decision():
                    return reward
                continue
            if nxt == math.inf or nxt > self._cutoff():
                self._now = max(self._now, min(nxt, self._cutoff()))
                return reward
            self._now = nxt
            if next_ready <= next_arrival:
                _, order_id = heapq.heappop(self._running)
                reward += self._complete(self._orders[order_id], nxt)
            else:
                self._queue.append(self._pending.pop(0))

    def _cut_off(self) -> float:
        unfinished = len(self._pending) + len(self._queue) + len(self._running)
        self._stats.unfinished = unfinished
        return -self.config.rewards.unfinished_penalty * unfinished

    def _observation(self) -> np.ndarray:
        cfg = self.config
        k = cfg.queue_window
        obs = np.zeros(k * FEATURES_PER_ORDER + GLOBAL_FEATURES, dtype=np.float32)
        for i, order in enumerate(self._queue[:k]):
            slack = order.slot_start - order.prep_nominal - self._now
            obs[i * FEATURES_PER_ORDER : (i + 1) * FEATURES_PER_ORDER] = (
                1.0,
                (order.slot_start - self._now) / 60.0,
                order.prep_nominal / 30.0,
                (self._now - order.arrival) / 60.0,
                slack / 60.0,
            )
        base = k * FEATURES_PER_ORDER
        obs[base : base + GLOBAL_FEATURES] = (
            self._now / cfg.service_minutes,
            (cfg.stations - len(self._running)) / cfg.stations,
            min(len(self._queue), 3 * k) / k,
            self._arrival_rate(self._now),
        )
        return np.clip(obs, -10.0, 10.0)

    def _arrival_rate(self, minute: float) -> float:
        rate = 0.0
        for start, value in self.config.arrival_profile:
            if minute >= start:
                rate = value
        return rate if minute < self.config.service_minutes else 0.0
