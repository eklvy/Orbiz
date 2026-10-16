"""Slot Nudger environment (Gymnasium contextual bandit), SYNTHETIC students.

Each step is one student checking out for a requested pickup slot. The advisor may suggest one
alternative slot from the candidates the server marks valid (not full, not too soon), or suggest
nothing. A simulated student accepts with a probability that falls with how far the slot moves
and depends on a hidden flexibility. The aim is to spread pickups so no slot gets crowded, without
pestering students. Reward design: ml/REWARD_DESIGN.md.
"""

import math
from dataclasses import asdict, dataclass, field
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces


@dataclass(frozen=True)
class SlotRewardWeights:
    # Crowding cost of a booking = crowding_weight x (slot utilisation after booking)^2.
    crowding_weight: float = 1.0
    # Cost of showing a nudge at all (students dislike prompts), and extra per 15 min moved.
    nudge_shown_cost: float = 0.05
    shift_cost_per_slot: float = 0.05


@dataclass(frozen=True)
class SlotNudgeConfig:
    slots: int = 16  # a 4-hour service in 15-minute slots
    capacity: int = 10  # orders per slot (outlets.default_slot_capacity)
    requests: int = 80  # checkouts per episode (about half of capacity, with a lunch peak)
    # How far a nudge may move the pickup, in slots (candidates: requested ± this).
    max_shift: int = 2
    # Demand peak: requested slot ~ Normal(peak_slot, peak_spread), clipped to open slots.
    peak_slot: float = 7.0
    peak_spread: float = 2.5
    # Student acceptance: p = sigmoid(flexibility - shift_aversion x |shift|), flexibility per
    # student ~ Normal(flexibility_mean, flexibility_sd). Hidden from the policy.
    flexibility_mean: float = 0.5
    flexibility_sd: float = 1.0
    shift_aversion: float = 1.0
    rewards: SlotRewardWeights = field(default_factory=SlotRewardWeights)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class SlotNudgeEnv(gym.Env[np.ndarray, int]):
    """Action 0 = no nudge; action 1 + j = suggest candidate j, where candidates are the slots
    requested - max_shift ... requested + max_shift (excluding the requested slot itself)."""

    metadata: dict[str, Any] = {"render_modes": []}  # noqa: RUF012

    def __init__(self, config: SlotNudgeConfig | None = None) -> None:
        super().__init__()
        self.config = config or SlotNudgeConfig()
        self.offsets = [
            d for d in range(-self.config.max_shift, self.config.max_shift + 1) if d != 0
        ]
        self.action_space: spaces.Discrete = spaces.Discrete(  # type: ignore[assignment]
            1 + len(self.offsets)
        )
        # Context: requested slot position, its utilisation, each candidate's utilisation and
        # validity, and how far through the booking period we are.
        size = 2 + 2 * len(self.offsets) + 1
        self.observation_space = spaces.Box(low=-1.0, high=2.0, shape=(size,), dtype=np.float32)
        self._reserved = np.zeros(self.config.slots, dtype=np.int64)
        self._step = 0
        self._requested = 0
        self._log: dict[str, list[float]] = {}

    # --- Gymnasium API ------------------------------------------------------------------------

    def reset(
        self, *, seed: int | None = None, options: dict[str, Any] | None = None
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        self._reserved = np.zeros(self.config.slots, dtype=np.int64)
        self._step = 0
        self._log = {"reward": [], "shown": [], "accepted": [], "shift": []}
        self._requested = self._draw_request()
        return self._observation(), {"synthetic": True}

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        if not self.action_masks()[action]:
            raise ValueError(f"action {action} is not valid now (use action_masks())")
        cfg, w = self.config, self.config.rewards
        requested = self._requested
        final = requested
        reward = 0.0
        shown = action != 0
        accepted = False
        if shown:
            target = requested + self.offsets[action - 1]
            shift = abs(self.offsets[action - 1])
            reward -= w.nudge_shown_cost + w.shift_cost_per_slot * shift
            flexibility = float(self.np_random.normal(cfg.flexibility_mean, cfg.flexibility_sd))
            p_accept = 1.0 / (1.0 + math.exp(-(flexibility - cfg.shift_aversion * shift)))
            if self.np_random.random() < p_accept:
                accepted = True
                final = target
        # Crowding saved: cost had they booked the requested slot minus the cost of the slot used.
        reward += self._crowding_cost(requested) - self._crowding_cost(final)
        self._reserved[final] += 1
        self._log["reward"].append(reward)
        self._log["shown"].append(float(shown))
        self._log["accepted"].append(float(accepted))
        self._log["shift"].append(float(abs(final - requested)))
        self._step += 1
        terminated = self._step >= cfg.requests or not self._any_space()
        info: dict[str, Any] = {"synthetic": True, "accepted": accepted, "slot": final}
        if terminated:
            info["metrics"] = self.metrics()
        else:
            self._requested = self._draw_request()
        return self._observation(), reward, terminated, False, info

    def action_masks(self) -> np.ndarray:
        """No nudge is always valid; a candidate is valid if it exists and has space."""
        mask = np.zeros(1 + len(self.offsets), dtype=bool)
        mask[0] = True
        for j, offset in enumerate(self.offsets):
            mask[1 + j] = self._has_space(self._requested + offset)
        return mask

    # --- What policies may see ----------------------------------------------------------------

    @property
    def requested_slot(self) -> int:
        return self._requested

    def utilisation(self, slot: int) -> float:
        return float(self._reserved[slot]) / self.config.capacity

    def metrics(self) -> dict[str, float]:
        util = self._reserved / self.config.capacity
        busy = util[util > 0]
        shown = sum(self._log["shown"])
        return {
            "bookings": float(self._reserved.sum()),
            "peak_utilisation": float(util.max()),
            "slots_over_80pct": float((util > 0.8).sum()),
            "utilisation_sd": float(busy.std()) if busy.size else 0.0,
            "nudge_rate": shown / max(len(self._log["shown"]), 1),
            "acceptance_rate": sum(self._log["accepted"]) / shown if shown else 0.0,
            "mean_shift_slots": float(np.mean(self._log["shift"])) if self._log["shift"] else 0.0,
            "total_reward": float(sum(self._log["reward"])),
        }

    # --- Internals ----------------------------------------------------------------------------

    def _has_space(self, slot: int) -> bool:
        return 0 <= slot < self.config.slots and self._reserved[slot] < self.config.capacity

    def _any_space(self) -> bool:
        return bool((self._reserved < self.config.capacity).any())

    def _crowding_cost(self, slot: int) -> float:
        after = (self._reserved[slot] + 1) / self.config.capacity
        return self.config.rewards.crowding_weight * float(after) ** 2

    def _draw_request(self) -> int:
        """A requested slot with space (the real checkout never offers a full slot)."""
        cfg = self.config
        for _ in range(100):
            slot = round(float(self.np_random.normal(cfg.peak_slot, cfg.peak_spread)))
            if self._has_space(slot):
                return slot
        open_slots = np.flatnonzero(self._reserved < cfg.capacity)
        return int(self.np_random.choice(open_slots))

    def _observation(self) -> np.ndarray:
        cfg = self.config
        values = [self._requested / max(cfg.slots - 1, 1), self.utilisation(self._requested)]
        for offset in self.offsets:
            slot = self._requested + offset
            valid = self._has_space(slot)
            values += [self.utilisation(slot) if 0 <= slot < cfg.slots else 1.0, float(valid)]
        values.append(self._step / cfg.requests)
        return np.clip(np.array(values, dtype=np.float32), -1.0, 2.0)
