"""The evaluation script: structure, labelling, and that it only reports what it ran."""

import json
from pathlib import Path

from campuscart_ml.evaluate import main


def test_evaluation_writes_labelled_results(tmp_path: Path) -> None:
    main(["--episodes", "3", "--seed", "11", "--out", str(tmp_path)])
    results = json.loads((tmp_path / "results.json").read_text())
    assert results["synthetic"] is True
    assert results["episodes"] == 3 and results["seeds"] == [11, 13]
    assert set(results["kitchen"]["policies"]) == {
        "fifo",
        "shortest_prep_first",
        "earliest_due_first",
        "least_slack_first",
        "just_in_time",
    }
    assert set(results["slots"]["policies"]) == {
        "never_nudge",
        "random_valid",
        "least_loaded",
        "threshold_rule",
    }
    on_time = results["kitchen"]["policies"]["fifo"]["on_time_rate"]
    assert 0.0 <= on_time["mean"] <= 1.0 and on_time["ci95"] >= 0.0
    table = (tmp_path / "results.md").read_text()
    assert table.startswith("_SYNTHETIC simulation, 3 episodes")
