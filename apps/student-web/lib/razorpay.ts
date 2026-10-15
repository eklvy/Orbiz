"use client";

import type { Schemas } from "@campuscart/client";
import { getApi } from "./api";

interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: "payment.failed", handler: () => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

let loading: Promise<void> | null = null;

function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load the payment window. Check your connection."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Opens Razorpay Checkout for a payment the server created (amount set by the server), then sends
 * the signed result back to the server, which verifies it before anything is marked paid.
 * Resolves with the server's verdict; rejects if the student closes the window.
 */
export async function payOnline(
  checkout: Schemas["Checkout"],
  description: string,
): Promise<Schemas["PaymentResult"]> {
  await loadCheckout();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error("The payment window isn't available.");
  const result = await new Promise<RazorpaySuccess>((resolve, reject) => {
    const instance = new Razorpay({
      key: checkout.key_id,
      order_id: checkout.provider_order_id,
      amount: checkout.amount_paise,
      currency: checkout.currency,
      name: "CampusCart",
      description,
      handler: resolve,
      modal: { ondismiss: () => reject(new Error("Payment cancelled")) },
      theme: { color: "#0f6b5c" },
    });
    instance.on("payment.failed", () =>
      reject(new Error("The payment failed. No money was taken.")),
    );
    instance.open();
  });
  return getApi().verifyCheckout(result);
}
