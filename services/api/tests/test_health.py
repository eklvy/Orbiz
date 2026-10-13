from fastapi.testclient import TestClient

from app.core.config import Environment, Settings
from app.main import create_app


def make_client(**overrides: object) -> TestClient:
    settings = Settings(environment=Environment.TEST, **overrides)  # type: ignore[arg-type]
    return TestClient(create_app(settings))


def test_health_reports_version_and_environment() -> None:
    response = make_client().get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.0.0", "environment": "test"}


def test_request_id_is_generated_and_echoed() -> None:
    client = make_client()
    generated = client.get("/api/v1/health")
    assert len(generated.headers["X-Request-ID"]) == 32

    echoed = client.get("/api/v1/health", headers={"X-Request-ID": "trace-123"})
    assert echoed.headers["X-Request-ID"] == "trace-123"


def test_unsafe_request_id_is_replaced() -> None:
    response = make_client().get("/api/v1/health", headers={"X-Request-ID": "bad id\nnewline"})
    assert response.headers["X-Request-ID"] != "bad id\nnewline"


def test_unknown_route_uses_error_envelope() -> None:
    response = make_client().get("/api/v1/does-not-exist", headers={"X-Request-ID": "r1"})
    assert response.status_code == 404
    assert response.json() == {
        "error": {"code": "not_found", "message": "Not Found", "request_id": "r1"}
    }


def test_docs_disabled_in_production() -> None:
    client = TestClient(create_app(Settings(environment=Environment.PRODUCTION)))
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
