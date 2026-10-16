"""Kitchen Dispatcher simulation settings (versioned with the code; see ml/configs/).

All numbers describe a SYNTHETIC lunch service. There is no real order history yet, so arrival
rates, prep times and noise are assumptions chosen to look like a busy campus cafe. They will be
re-fitted to real orders once the pilot produces them (docs/IMPLEMENTATION_STATUS.md, Phase 6A).
"""

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class KitchenRewardWeights:
    """Reward design (ml/REWARD_DESIGN.md). Per finished order, in "minutes of student time"."""

    # Ready by the start of the student's pickup slot.
    on_time_bonus: float = 1.0
    # Each minute ready after the slot starts (the student is waiting at the counter).
    late_per_minute: float = 1.0
    # Extra per minute after the slot has ended (the student has likely given up or is late
    # for class) on top of late_per_minute.
    very_late_per_minute: float = 2.0
    # Each minute the food sits ready beyond `early_tolerance_minutes` before the slot (it cools).
    early_per_minute: float = 0.2
    # Each order still unfinished when the episode is cut off.
    unfinished_penalty: float = 30.0


@dataclass(frozen=True)
class KitchenConfig:
    # One lunch service: orders arrive for this many minutes.
    service_minutes: int = 180
    # Orders cooked in parallel (outlets.concurrent_orders; default 2 in the database).
    stations: int = 2
    # How many waiting orders the dispatcher can see and choose from (oldest first).
    queue_window: int = 12
    # Piecewise arrival rate (orders per minute) as (from_minute, rate): a lunch peak.
    arrival_profile: tuple[tuple[int, float], ...] = (
        (0, 0.25),
        (40, 0.55),
        (100, 0.3),
        (150, 0.15),
    )
    # Pickup slot grid (outlets.slot_minutes; default 15).
    slot_minutes: int = 15
    # Students pick "the first slot the kitchen can make" or a later one:
    # weights for 0..3 extra slots.
    extra_slot_weights: tuple[float, ...] = (0.5, 0.25, 0.15, 0.1)
    # Nominal prep time of an order (its longest item), minutes, with weights.
    prep_minutes: tuple[int, ...] = (2, 3, 4, 5, 6, 8)
    prep_weights: tuple[float, ...] = (0.1, 0.2, 0.25, 0.2, 0.15, 0.1)
    # Actual prep = nominal x lognormal(0, sigma): kitchens are not perfectly predictable.
    prep_noise_sigma: float = 0.2
    # Food may be ready up to this many minutes before the slot without a penalty.
    early_tolerance_minutes: float = 10.0
    # After the last arrival the kitchen gets this long to finish before the episode is cut off.
    overtime_minutes: int = 60
    # The "wait one minute" action (lets a policy time cooking to the slot).
    wait_minutes: float = 1.0
    rewards: KitchenRewardWeights = field(default_factory=KitchenRewardWeights)

    def __post_init__(self) -> None:
        if self.stations < 1 or self.queue_window < 1:
            raise ValueError("stations and queue_window must be at least 1")
        if len(self.prep_minutes) != len(self.prep_weights):
            raise ValueError("prep_minutes and prep_weights must have the same length")
        if not self.arrival_profile or self.arrival_profile[0][0] != 0:
            raise ValueError("arrival_profile must start at minute 0")

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)

    @classmethod
    def from_json(cls, path: Path) -> "KitchenConfig":
        data: dict[str, Any] = json.loads(path.read_text())
        rewards = KitchenRewardWeights(**data.pop("rewards", {}))
        tuples = {
            key: tuple(tuple(v) if isinstance(v, list) else v for v in value)
            for key, value in data.items()
            if isinstance(value, list)
        }
        return cls(**{**data, **tuples, "rewards": rewards})
