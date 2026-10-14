"""Public catalogue endpoints and the server-side cart."""

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.integration.conftest import OutletFixture, User

pytestmark = pytest.mark.integration


def test_outlet_list_is_public_and_carries_live_state(api: TestClient) -> None:
    response = api.get("/api/v1/outlets")
    assert response.status_code == 200, response.text
    by_slug = {o["slug"]: o for o in response.json()}
    north = by_slug["dev-north-cafe"]
    assert north["status"] == "open"
    assert north["accepting_orders"] is True
    assert set(north["queue"]) == {"active_orders", "estimated_wait_minutes", "crowd_level"}
    assert "dev-closed-kiosk" not in by_slug, "inactive outlets are hidden"


def test_outlet_detail_by_slug_includes_hours(api: TestClient) -> None:
    response = api.get("/api/v1/outlets/dev-south-canteen")
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["hours"]) == 14, "two services a day, seven days"
    assert api.get("/api/v1/outlets/no-such-outlet").status_code == 404


def test_menu_filters(api: TestClient, outlet: OutletFixture) -> None:
    url = f"/api/v1/outlets/{outlet.id}/menu"

    def names(response: Any) -> list[str]:
        return sorted(i["name"] for i in response.json()["uncategorized"])

    assert names(api.get(url)) == ["Test Chai", "Test Sandwich"]
    assert names(api.get(url, params={"diet": "egg"})) == ["Test Sandwich"]
    assert names(api.get(url, params={"max_price_paise": 2000})) == ["Test Chai"]
    assert names(api.get(url, params={"q": "sand"})) == ["Test Sandwich"]
    assert names(api.get(url, params={"q": "%"})) == [], "LIKE wildcards are escaped"

    chai = next(i for i in api.get(url).json()["uncategorized"] if i["name"] == "Test Chai")
    assert chai["quantity_available"] == 10
    assert chai["stock_status"] == "available"
    assert chai["price_paise"] == 2000


def test_sold_out_items_can_be_filtered(
    api: TestClient, outlet: OutletFixture, sql: psycopg.Connection[dict[str, Any]]
) -> None:
    sql.execute(
        "update public.inventory set quantity_available = 0 where menu_item_id = %s",
        (outlet.chai_id,),
    )
    url = f"/api/v1/outlets/{outlet.id}/menu"
    items = {i["name"]: i for i in api.get(url).json()["uncategorized"]}
    assert items["Test Chai"]["stock_status"] == "sold_out"
    available = api.get(url, params={"available_only": True}).json()["uncategorized"]
    assert [i["name"] for i in available] == ["Test Sandwich"]


def test_pickup_slots_show_remaining_capacity(api: TestClient, outlet: OutletFixture) -> None:
    response = api.get(f"/api/v1/outlets/{outlet.id}/pickup-slots")
    assert response.status_code == 200, response.text
    slots = {s["id"]: s for s in response.json()}
    assert slots[str(outlet.small_slot_id)]["remaining"] == 2
    assert slots[str(outlet.small_slot_id)]["bookable"] is True


def test_cart_round_trip_and_outlet_switch(
    api: TestClient, outlet: OutletFixture, students: list[User]
) -> None:
    student = students[0]
    api.delete("/api/v1/cart", headers=student.headers)

    put = api.put(
        f"/api/v1/cart/items/{outlet.chai_id}", headers=student.headers, json={"quantity": 2}
    )
    assert put.status_code == 200, put.text
    cart = put.json()
    assert cart["outlet_id"] == str(outlet.id)
    assert cart["subtotal_paise"] == 4000
    assert cart["items"][0]["orderable"] is True

    # The same cart is visible from any device (it's server-side).
    assert api.get("/api/v1/cart", headers=student.headers).json()["item_count"] == 2

    north_chai = "00000000-0000-4000-d000-000000000001"
    conflict = api.put(
        f"/api/v1/cart/items/{north_chai}", headers=student.headers, json={"quantity": 1}
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["details"]["reason"] == "cart_outlet_mismatch"

    replaced = api.put(
        f"/api/v1/cart/items/{north_chai}",
        headers=student.headers,
        json={"quantity": 1, "replace_cart": True},
    )
    assert replaced.status_code == 200
    assert replaced.json()["outlet_id"] == "00000000-0000-4000-b000-000000000001"

    emptied = api.delete(f"/api/v1/cart/items/{north_chai}", headers=student.headers)
    assert emptied.json() == {"outlet_id": None, "items": [], "subtotal_paise": 0, "item_count": 0}


def test_cart_requires_sign_in(api: TestClient) -> None:
    assert api.get("/api/v1/cart").status_code == 401


def test_cart_rejects_unknown_items_and_bad_quantities(
    api: TestClient, students: list[User]
) -> None:
    student = students[0]
    missing = api.put(
        "/api/v1/cart/items/00000000-0000-4000-d000-0000000000ff",
        headers=student.headers,
        json={"quantity": 1},
    )
    assert missing.status_code == 404
    north_chai = "00000000-0000-4000-d000-000000000001"
    too_many = api.put(
        f"/api/v1/cart/items/{north_chai}", headers=student.headers, json={"quantity": 21}
    )
    assert too_many.status_code == 422


@pytest.mark.anyio
async def test_concurrent_first_adds_create_one_cart(
    settings: Any, outlet: OutletFixture, students: list[User]
) -> None:
    """Two quick taps on different items must both land (regression: second tap returned 500)."""
    import asyncio

    import httpx2 as httpx

    from app.main import create_app

    student = students[5]
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://api.test"
        ) as client,
    ):
        await client.delete("/api/v1/cart", headers=student.headers)
        responses = await asyncio.gather(
            *(
                client.put(
                    f"/api/v1/cart/items/{item}", headers=student.headers, json={"quantity": 1}
                )
                for item in (outlet.chai_id, outlet.sandwich_id)
            )
        )
        assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
        cart = (await client.get("/api/v1/cart", headers=student.headers)).json()
        assert cart["item_count"] == 2
        await client.delete("/api/v1/cart", headers=student.headers)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
