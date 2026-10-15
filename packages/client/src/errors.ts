import { CampusCartApiError } from "./api";

export interface FriendlyError {
  message: string;
  /** What the student can do next, when there is something useful to suggest. */
  hint: string | null;
}

const HINTS: Record<string, string> = {
  insufficient_stock: "Lower the quantity or choose something else.",
  item_unavailable: "Remove it from your cart to continue.",
  slot_full: "Pick another pickup time.",
  slot_too_soon: "Pick a later pickup time.",
  slot_unavailable: "Pick another pickup time.",
  outlet_not_accepting_orders: "Try again when the outlet reopens, or order from another outlet.",
  too_many_pending_orders: "Open your orders to finish or cancel the unpaid ones.",
  cart_outlet_mismatch: "Your cart can only hold items from one outlet at a time.",
  deal_unavailable: "Check the other deals, or order from the menu.",
  own_deal: "Ask at the counter if you still want this food.",
  refund_window_closed: "Contact the outlet directly if something went wrong.",
  no_show_not_refundable: "Orders must be collected by the pickup deadline.",
  capacity_below_reserved: "Lower it only to the number already booked, or stop new bookings.",
  user_not_found: "Ask them to create a CampusCart account first.",
};

/** Turns any thrown value into a message fit to show a student. */
export function friendlyError(error: unknown): FriendlyError {
  if (error instanceof CampusCartApiError) {
    if (error.code === "network_error") {
      return { message: "Can't reach CampusCart.", hint: "Check your connection and try again." };
    }
    if (error.code === "unauthenticated") {
      return { message: "Your session has ended.", hint: "Please sign in again." };
    }
    if (error.code === "internal_error" || error.code === "service_unavailable") {
      return {
        message: "Something went wrong on our side.",
        hint: "Please try again in a moment.",
      };
    }
    return { message: error.message, hint: (error.reason && HINTS[error.reason]) ?? null };
  }
  return { message: "Something went wrong.", hint: "Please try again." };
}
