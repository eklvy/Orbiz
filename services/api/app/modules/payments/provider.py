"""Razorpay: create orders over its REST API and verify checkout and webhook signatures.

Signatures are HMAC-SHA256 (checkout: key secret over "order_id|payment_id"; webhooks: webhook
secret over the raw body), compared in constant time. Nothing here marks money as received; the
service records a capture only after a signature checks out.
"""

import hashlib
import hmac
import logging
from typing import Any

import httpx2 as httpx
from fastapi import Request

from app.core.config import Settings
from app.core.errors import ApiError

logger = logging.getLogger(__name__)


def hmac_sha256_hex(secret: str, message: bytes) -> str:
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


class Razorpay:
    def __init__(
        self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        assert settings.razorpay_key_id and settings.razorpay_key_secret  # noqa: S101
        self.key_id = settings.razorpay_key_id
        self._secret = settings.razorpay_key_secret.get_secret_value()
        self._webhook_secret = (
            settings.razorpay_webhook_secret.get_secret_value()
            if settings.razorpay_webhook_secret
            else None
        )
        self._client = httpx.AsyncClient(
            base_url=settings.razorpay_api_base.rstrip("/"),
            auth=(self.key_id, self._secret),
            timeout=10,
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def create_order(self, amount_paise: int, receipt: str, notes: dict[str, str]) -> str:
        try:
            response = await self._client.post(
                "/orders",
                json={
                    "amount": amount_paise,
                    "currency": "INR",
                    "receipt": receipt[:40],
                    "notes": notes,
                },
            )
        except httpx.HTTPError as exc:
            logger.warning("razorpay order create failed: %s", type(exc).__name__)
            raise ApiError(
                503,
                "service_unavailable",
                "Payments are unavailable right now",
                {"reason": "payment_provider_unavailable"},
            ) from exc
        if response.status_code >= 400:
            logger.warning("razorpay order create rejected: %s", response.status_code)
            raise ApiError(
                503,
                "service_unavailable",
                "Payments are unavailable right now",
                {"reason": "payment_provider_error"},
            )
        body: dict[str, Any] = response.json()
        provider_order_id = body.get("id")
        if not isinstance(provider_order_id, str) or body.get("amount") != amount_paise:
            raise ApiError(
                503,
                "service_unavailable",
                "Payments are unavailable right now",
                {"reason": "payment_provider_error"},
            )
        return provider_order_id

    def checkout_signature_valid(self, order_id: str, payment_id: str, signature: str) -> bool:
        expected = hmac_sha256_hex(self._secret, f"{order_id}|{payment_id}".encode())
        return hmac.compare_digest(expected, signature)

    def webhook_signature_valid(self, body: bytes, signature: str) -> bool:
        if not self._webhook_secret:
            return False
        return hmac.compare_digest(hmac_sha256_hex(self._webhook_secret, body), signature)


def get_razorpay(request: Request) -> Razorpay:
    """FastAPI dependency: the configured provider, or 503 when online payment isn't set up."""
    provider: Razorpay | None = getattr(request.app.state, "razorpay", None)
    if provider is None:
        raise ApiError(
            503,
            "service_unavailable",
            "Online payment isn't set up on this server. Pay from your CampusCart wallet instead.",
            {"reason": "payments_unavailable"},
        )
    return provider
