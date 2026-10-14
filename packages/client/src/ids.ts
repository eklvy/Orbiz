/** A fresh idempotency key for one checkout attempt (retries reuse it). */
export function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `checkout-${uuid}`;
  // Hermes (React Native) lacks crypto.randomUUID; keys only need to be unique per user.
  return `checkout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}
