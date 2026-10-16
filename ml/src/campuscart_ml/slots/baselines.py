"""Baseline nudge policies (yardsticks for the Thompson-sampling bandit in Phase 6B). Each sees
the requested slot, slot utilisation and the valid candidates — never a student's flexibility —
and always returns a valid action."""

from collections.abc import Callable

import numpy as np

from campuscart_ml.slots.env import SlotNudgeEnv

Policy = Callable[[SlotNudgeEnv], int]


def never_nudge(env: SlotNudgeEnv) -> int:
    return 0


def random_valid(env: SlotNudgeEnv) -> int:
    """Suggest a random valid alternative every time (shows the cost of pestering)."""
    choices = np.flatnonzero(env.action_masks()[1:]) + 1
    return int(env.np_random.choice(choices)) if choices.size else 0


def least_loaded(env: SlotNudgeEnv) -> int:
    """Suggest the least crowded valid alternative, if it is less crowded than the request
    (ties: the nearer slot)."""
    mask = env.action_masks()
    current = env.utilisation(env.requested_slot)
    best, best_key = 0, (current, 0)
    for j, offset in enumerate(env.offsets):
        if mask[1 + j]:
            key = (env.utilisation(env.requested_slot + offset), abs(offset))
            if key < best_key:
                best, best_key = 1 + j, key
    return best


def threshold_rule(env: SlotNudgeEnv, busy: float = 0.7, calm: float = 0.5) -> int:
    """Only nudge when the requested slot is at least `busy` full, and only to the nearest valid
    slot below `calm` (prefer the later slot on a tie: students rarely want to collect earlier)."""
    if env.utilisation(env.requested_slot) < busy:
        return 0
    mask = env.action_masks()
    options = [
        (abs(offset), -offset, 1 + j)
        for j, offset in enumerate(env.offsets)
        if mask[1 + j] and env.utilisation(env.requested_slot + offset) < calm
    ]
    return min(options)[2] if options else 0


POLICIES: dict[str, Policy] = {
    "never_nudge": never_nudge,
    "random_valid": random_valid,
    "least_loaded": least_loaded,
    "threshold_rule": threshold_rule,
}
