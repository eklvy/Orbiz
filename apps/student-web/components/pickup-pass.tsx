"use client";

import { pickupQrPayload, type Schemas } from "@campuscart/client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** Digital Campus Food Pass: token, QR and the code to read out at the counter. */
export function PickupPass({ order }: { order: Schemas["OrderDetail"] }) {
  const payload = pickupQrPayload(order);
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (!payload) return;
    void QRCode.toString(payload, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(
      setSvg,
    );
  }, [payload]);
  // Only useful while the order can still be collected.
  const ended = ["no_show", "cancelled", "rejected"].includes(order.status);
  if (!payload || !order.token_label || ended) return null;
  return (
    <section
      aria-label="Pickup pass"
      className="grid gap-4 rounded-2xl border-2 border-primary bg-surface p-5 sm:grid-cols-[auto_1fr] sm:items-center"
    >
      <div
        className="mx-auto size-40 rounded-lg bg-white p-2 [&_svg]:size-full"
        role="img"
        aria-label={`QR code for token ${order.token_label}`}
        // QR SVG generated locally from the order id and pickup code.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <div className="text-center sm:text-left">
        <p className="text-sm text-muted">Your token</p>
        <p className="text-4xl font-black tracking-tight text-primary" data-testid="token">
          {order.token_label}
        </p>
        <p className="mt-3 text-sm text-muted">Pickup code</p>
        <p className="font-mono text-2xl font-bold tracking-[0.3em]" data-testid="pickup-code">
          {order.pickup_code}
        </p>
        <p className="mt-2 text-xs text-muted">
          Show the QR or read this code at the counter. Don&apos;t share it before pickup.
        </p>
      </div>
    </section>
  );
}
