"""Pure unit tests for ordering helpers (no database)."""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError

from app.core.db import translate_db_error
from app.core.errors import ApiError
from app.modules.catalog.service import crowd_level
from app.modules.orders.schemas import OrderCreate
from app.modules.orders.service import decode_cursor, encode_cursor, request_hash

OUTLET, SLOT, CHAI, SAMOSA = (uuid.uuid4() for _ in range(4))


def order(items: list[dict[str, Any]], slot: uuid.UUID = SLOT) -> OrderCreate:
    return OrderCreate.model_validate({"outlet_id": OUTLET, "pickup_slot_id": slot, "items": items})


def test_request_hash_ignores_line_order_and_splitting() -> None:
    a = order([{"menu_item_id": CHAI, "quantity": 2}, {"menu_item_id": SAMOSA, "quantity": 1}])
    b = order(
        [
            {"menu_item_id": SAMOSA, "quantity": 1},
            {"menu_item_id": CHAI, "quantity": 1},
            {"menu_item_id": CHAI, "quantity": 1},
        ]
    )
    assert request_hash(a) == request_hash(b)


def test_request_hash_changes_with_content() -> None:
    base = order([{"menu_item_id": CHAI, "quantity": 2}])
    assert request_hash(base) != request_hash(order([{"menu_item_id": CHAI, "quantity": 3}]))
    assert request_hash(base) != request_hash(
        order([{"menu_item_id": CHAI, "quantity": 2}], uuid.uuid4())
    )


@pytest.mark.parametrize(
    "body",
    [
        {"items": []},
        {"items": [{"menu_item_id": str(CHAI), "quantity": 0}]},
        {"items": [{"menu_item_id": str(CHAI), "quantity": 21}]},
        {"items": [{"menu_item_id": str(CHAI), "quantity": 1, "price_paise": 1}]},
        {"items": [{"menu_item_id": str(CHAI), "quantity": 1}], "total_paise": 1},
        {"items": [{"menu_item_id": str(uuid.uuid4()), "quantity": 1}] * 21},
    ],
)
def test_order_payload_rejects_invalid_or_client_priced_input(body: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        OrderCreate.model_validate({"outlet_id": str(OUTLET), "pickup_slot_id": str(SLOT), **body})


def test_cursor_round_trip() -> None:
    created, order_id = datetime(2026, 10, 14, 12, 30, tzinfo=UTC), uuid.uuid4()
    assert decode_cursor(encode_cursor(created, order_id)) == (created, order_id)


@pytest.mark.parametrize("cursor", ["", "not-base64!!", "aGVsbG8"])
def test_bad_cursor_is_a_validation_error(cursor: str) -> None:
    with pytest.raises(ApiError) as exc:
        decode_cursor(cursor)
    assert exc.value.status_code == 422


@pytest.mark.parametrize(
    ("wait", "level"), [(0, "low"), (5, "low"), (6, "medium"), (15, "medium"), (16, "high")]
)
def test_crowd_level_thresholds(wait: int, level: str) -> None:
    assert crowd_level(wait) == level


class FakeDiag:
    def __init__(self, primary: str | None, hint: str | None) -> None:
        self.message_primary = primary
        self.message_hint = hint


class FakePgError(Exception):
    def __init__(self, sqlstate: str, primary: str | None = None, hint: str | None = None) -> None:
        self.sqlstate = sqlstate
        self.diag = FakeDiag(primary, hint)


@pytest.mark.parametrize(
    ("sqlstate", "status", "code"),
    [
        ("CC409", 409, "conflict"),
        ("CC404", 404, "not_found"),
        ("CC403", 403, "forbidden"),
        ("CC422", 422, "validation_error"),
        ("CC401", 401, "unauthenticated"),
    ],
)
def test_business_errors_map_to_envelope(sqlstate: str, status: int, code: str) -> None:
    error = translate_db_error(FakePgError(sqlstate, "Not enough Chai left", "insufficient_stock"))  # type: ignore[arg-type]
    assert error is not None
    assert (error.status_code, error.code, error.message) == (status, code, "Not enough Chai left")
    assert error.details == {"reason": "insufficient_stock"}


def test_malformed_input_maps_to_422_and_unknown_errors_are_not_swallowed() -> None:
    bad_uuid = translate_db_error(FakePgError("22P02", "invalid input syntax for type uuid"))  # type: ignore[arg-type]
    assert bad_uuid is not None and bad_uuid.status_code == 422
    assert translate_db_error(FakePgError("40P01", "deadlock detected")) is None  # type: ignore[arg-type]
