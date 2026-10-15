import type { RealtimePostgresChangesPayload, SupabaseClient } from "@supabase/supabase-js";

export type RealtimeStatus = "connecting" | "live" | "reconnecting";

export interface TableSubscription {
  table:
    | "orders"
    | "order_events"
    | "outlets"
    | "menu_items"
    | "inventory"
    | "pickup_slots"
    | "refund_requests"
    | "surplus_deals"
    | "wallet_accounts"
    | "loyalty_accounts"
    | "notifications"
    | "daily_specials"
    | "polls"
    | "poll_options"
    | "group_sessions";
  /** PostgREST-style filter, e.g. `id=eq.<uuid>`. */
  filter?: string;
  onChange: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void;
  /**
   * Called every time the subscription becomes live (first connect and each reconnect).
   * Clients refetch authoritative state here, because events may have been missed while
   * disconnected. The database, not the event stream, is the source of truth.
   */
  onResync?: () => void;
  onStatus?: (status: RealtimeStatus) => void;
}

let channelCounter = 0;

/** Subscribes to row changes the signed-in user may see (RLS applies). Returns an unsubscribe. */
export function subscribeToTable(
  supabase: SupabaseClient,
  subscription: TableSubscription,
): () => void {
  const { table, filter, onChange, onResync, onStatus } = subscription;
  channelCounter += 1;
  const channel = supabase.channel(`cc-${table}-${channelCounter}-${Date.now()}`);
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table, ...(filter ? { filter } : {}) },
    onChange,
  );
  onStatus?.("connecting");
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      onStatus?.("live");
      onResync?.();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      onStatus?.("reconnecting");
    }
  });
  return () => {
    void supabase.removeChannel(channel);
  };
}
