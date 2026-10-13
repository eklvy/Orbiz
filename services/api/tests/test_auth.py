"""Token verification, without network or database (keys generated per test session)."""

import secrets
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.core.auth import TokenVerifier
from app.core.config import Environment, Settings
from app.main import create_app

ISSUER = "http://supabase.test/auth/v1"
USER_ID = "7f1f8a52-5b0e-4b7a-9d8e-0d9f5c2a1b3c"
HS_SECRET = secrets.token_urlsafe(32)

EC_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_EC_KEY = ec.generate_private_key(ec.SECP256R1())


def claims(**overrides: Any) -> dict[str, Any]:
    now = int(time.time())
    base = {
        "sub": USER_ID,
        "aud": "authenticated",
        "iss": ISSUER,
        "role": "authenticated",
        "email": "student@campus.test",
        "iat": now,
        "exp": now + 600,
    }
    base.update(overrides)
    return {k: v for k, v in base.items() if v is not None}


def es256(payload: dict[str, Any], key: ec.EllipticCurvePrivateKey = EC_KEY) -> str:
    return jwt.encode(payload, key, algorithm="ES256", headers={"kid": "test"})


def verifier(hs256_secret: str | None = None) -> TokenVerifier:
    return TokenVerifier(
        issuer=ISSUER,
        audience="authenticated",
        hs256_secret=hs256_secret,
        signing_key_resolver=lambda _token: EC_KEY.public_key(),
    )


@pytest.fixture
def client() -> TestClient:
    # No database configured: a request that passes authentication then gets a 503,
    # which lets these tests distinguish "auth passed" from "auth rejected".
    app = create_app(Settings(environment=Environment.TEST))
    app.state.token_verifier = verifier(hs256_secret=HS_SECRET)
    return TestClient(app)


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_valid_es256_token_is_accepted() -> None:
    assert verifier().verify(es256(claims()))["sub"] == USER_ID


def test_valid_hs256_token_is_accepted_when_secret_configured() -> None:
    token = jwt.encode(claims(), HS_SECRET, algorithm="HS256")
    assert verifier(hs256_secret=HS_SECRET).verify(token)["sub"] == USER_ID


@pytest.mark.parametrize(
    ("description", "token"),
    [
        ("expired", es256(claims(exp=int(time.time()) - 10))),
        ("wrong audience", es256(claims(aud="something-else"))),
        ("wrong issuer", es256(claims(iss="http://evil.test/auth/v1"))),
        ("missing sub", es256(claims(sub=None))),
        ("missing exp", es256(claims(exp=None))),
        ("signed by another key", es256(claims(), OTHER_EC_KEY)),
        ("anon-key style token", es256(claims(role="anon"))),
        ("service-role token", es256(claims(role="service_role"))),
        ("alg none", jwt.encode(claims(), "", algorithm="none")),
        ("HS256 with no secret configured", jwt.encode(claims(), HS_SECRET, algorithm="HS256")),
        ("garbage", "not-a-jwt"),
    ],
)
def test_invalid_tokens_are_rejected(description: str, token: str) -> None:
    from app.core.auth import InvalidTokenError

    with pytest.raises(InvalidTokenError):
        verifier().verify(token)


def test_verifier_without_issuer_rejects_everything() -> None:
    from app.core.auth import InvalidTokenError

    unconfigured = TokenVerifier(issuer=None, audience="authenticated")
    with pytest.raises(InvalidTokenError):
        unconfigured.verify(es256(claims()))


def test_missing_bearer_token_returns_401_envelope(client: TestClient) -> None:
    response = client.get("/api/v1/me")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_non_bearer_scheme_returns_401(client: TestClient) -> None:
    response = client.get("/api/v1/me", headers={"Authorization": "Basic abc"})
    assert response.status_code == 401


def test_tampered_token_returns_401(client: TestClient) -> None:
    header, payload, signature = es256(claims()).split(".")
    forged_payload = jwt.utils.base64url_encode(
        jwt.utils.base64url_decode(payload).replace(b"student@", b"attacker@")
    ).decode()
    response = client.get("/api/v1/me", headers=auth(f"{header}.{forged_payload}.{signature}"))
    assert response.status_code == 401


def test_valid_token_passes_auth_then_reports_missing_database(client: TestClient) -> None:
    response = client.get("/api/v1/me", headers=auth(es256(claims())))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"


def test_readiness_without_database_is_503(client: TestClient) -> None:
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"


def test_deployed_environments_require_supabase_and_database_settings() -> None:
    with pytest.raises(ValueError, match="CAMPUSCART_SUPABASE_URL"):
        Settings(environment=Environment.PRODUCTION)
