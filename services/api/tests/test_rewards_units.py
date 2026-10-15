"""Pure rules behind the loyalty and budget screens (D-15)."""

from app.modules.rewards.service import _status, tier_for


def test_tiers_follow_lifetime_points() -> None:
    assert tier_for(0) == ("silver", 1000)
    assert tier_for(999) == ("silver", 1)
    assert tier_for(1000) == ("gold", 2000)
    assert tier_for(2999) == ("gold", 1)
    assert tier_for(3000) == ("platinum", None)
    assert tier_for(50_000) == ("platinum", None)


def test_budget_status_uses_integer_paise_and_the_warning_threshold() -> None:
    assert _status(0, None, None) is None
    assert _status(79_999, 100_000, 80) == "ok"
    assert _status(80_000, 100_000, 80) == "near"
    assert _status(100_000, 100_000, 80) == "near"  # at the limit, not over it
    assert _status(100_001, 100_000, 80) == "over"
