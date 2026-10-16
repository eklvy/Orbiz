"""Baseline dispatch policies. Each sees only what a real kitchen sees: the visible waiting orders
(arrival, pickup slot, nominal prep time) and the clock — never the actual prep time. Each always
returns a valid action. These are the yardsticks the learned dispatcher must beat (Phase 6B)."""

from collections.abc import Callable

from campuscart_ml.kitchen.env import KitchenDispatchEnv, OrderView

Policy = Callable[[KitchenDispatchEnv], int]


def _pick(env: KitchenDispatchEnv, key: Callable[[OrderView], tuple[float, ...]]) -> int:
    queue = env.visible_queue()
    return min(queue, key=key).index


def fifo(env: KitchenDispatchEnv) -> int:
    """First in, first out: the order that arrived first."""
    return _pick(env, lambda o: (o.arrival,))


def shortest_prep_first(env: KitchenDispatchEnv) -> int:
    """SPT: the quickest order first (ties: oldest)."""
    return _pick(env, lambda o: (o.prep_nominal, o.arrival))


def earliest_due_first(env: KitchenDispatchEnv) -> int:
    """EDD: the order whose pickup slot starts first (ties: oldest)."""
    return _pick(env, lambda o: (o.slot_start, o.arrival))


def least_slack_first(env: KitchenDispatchEnv) -> int:
    """The order that must start soonest to be ready by its slot (slot start - prep)."""
    return _pick(env, lambda o: (o.slot_start - o.prep_nominal, o.arrival))


def just_in_time(env: KitchenDispatchEnv, hold_if_slack_over: float = 8.0) -> int:
    """Rule-based: least slack first, but when the kitchen is not busy (no more waiting orders than
    stations) and even the most urgent order could start more than `hold_if_slack_over` minutes
    from now and still be on time, wait a minute so food isn't ready long before pickup (it would
    cool). Under load it never holds back."""
    queue = env.visible_queue()
    urgent = min(queue, key=lambda o: (o.slot_start - o.prep_nominal, o.arrival))
    slack = urgent.slot_start - urgent.prep_nominal - env.now
    quiet = len(queue) <= env.config.stations
    if quiet and slack > hold_if_slack_over:
        return env.wait_action
    return urgent.index


POLICIES: dict[str, Policy] = {
    "fifo": fifo,
    "shortest_prep_first": shortest_prep_first,
    "earliest_due_first": earliest_due_first,
    "least_slack_first": least_slack_first,
    "just_in_time": just_in_time,
}
