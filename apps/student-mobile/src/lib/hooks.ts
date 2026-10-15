import {
  isNewerVersion,
  queryKeys,
  subscribeToTable,
  type MenuFilters,
  type RealtimeStatus,
  type Schemas,
} from "@campuscart/client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import { supabase } from "./supabase";

// Thin React glue over the shared @campuscart/client logic (same behaviour as the website's
// hooks): Realtime events and reconnects trigger refetches from the authoritative API.

export function useOutlets() {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<RealtimeStatus>("connecting");
  useEffect(
    () =>
      subscribeToTable(supabase, {
        table: "outlets",
        onChange: () => void queryClient.invalidateQueries({ queryKey: queryKeys.outlets }),
        onResync: () => void queryClient.invalidateQueries({ queryKey: queryKeys.outlets }),
        onStatus: setLive,
      }),
    [queryClient],
  );
  return { ...useQuery({ queryKey: queryKeys.outlets, queryFn: api.listOutlets }), live };
}

export function useOutlet(ref: string | undefined) {
  return useQuery({
    queryKey: queryKeys.outlet(ref ?? ""),
    queryFn: () => api.getOutlet(ref as string),
    enabled: Boolean(ref),
  });
}

export function useMenu(outletId: string | undefined, filters: MenuFilters) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!outletId) return;
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.menuAll(outletId) });
    const offItems = subscribeToTable(supabase, {
      table: "menu_items",
      filter: `outlet_id=eq.${outletId}`,
      onChange: refresh,
    });
    const offStock = subscribeToTable(supabase, { table: "inventory", onChange: refresh });
    return () => {
      offItems();
      offStock();
    };
  }, [outletId, queryClient]);
  return useQuery({
    queryKey: queryKeys.menu(outletId ?? "", filters),
    queryFn: () => api.getMenu(outletId as string, filters),
    enabled: Boolean(outletId),
    placeholderData: (previous) => previous,
  });
}

export function usePickupSlots(outletId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.slots(outletId ?? ""),
    queryFn: () => api.listPickupSlots(outletId as string),
    enabled: Boolean(outletId),
    refetchInterval: 60_000,
  });
}

/** Surplus deals on sale (D-19): Realtime for new deals, plus a 30 s refresh for ones that end. */
export function useDeals(outletId: string | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!outletId) return;
    return subscribeToTable(supabase, {
      table: "surplus_deals",
      filter: `outlet_id=eq.${outletId}`,
      onChange: () => void queryClient.invalidateQueries({ queryKey: queryKeys.deals(outletId) }),
    });
  }, [outletId, queryClient]);
  return useQuery({
    queryKey: queryKeys.deals(outletId ?? ""),
    queryFn: () => api.listDeals(outletId as string),
    enabled: Boolean(outletId),
    refetchInterval: 30_000,
  });
}

export function useCart() {
  const { session } = useAuth();
  return useQuery({ queryKey: queryKeys.cart, queryFn: api.getCart, enabled: Boolean(session) });
}

export function useSetCartItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { menuItemId: string; quantity: number; replaceCart?: boolean }) =>
      vars.quantity > 0
        ? api.setCartItem(vars.menuItemId, vars.quantity, vars.replaceCart)
        : api.removeCartItem(vars.menuItemId),
    onSuccess: (cart) => queryClient.setQueryData(queryKeys.cart, cart),
  });
}

export function useTransitions() {
  return useQuery({
    queryKey: queryKeys.transitions,
    queryFn: api.listTransitions,
    staleTime: Infinity,
  });
}

export function useOrder(orderId: string) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [live, setLive] = useState<RealtimeStatus>("connecting");
  useEffect(() => {
    if (!session) return;
    const key = queryKeys.order(orderId);
    return subscribeToTable(supabase, {
      table: "orders",
      filter: `id=eq.${orderId}`,
      onChange: (payload) => {
        const incoming = payload.new as { version?: number } | null;
        const current = queryClient.getQueryData<Schemas["OrderDetail"]>(key);
        if (
          incoming?.version === undefined ||
          isNewerVersion(current, { version: incoming.version })
        ) {
          void queryClient.invalidateQueries({ queryKey: key });
          void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
        }
      },
      onResync: () => void queryClient.invalidateQueries({ queryKey: key }),
      onStatus: setLive,
    });
  }, [orderId, session, queryClient]);
  return {
    ...useQuery({
      queryKey: queryKeys.order(orderId),
      queryFn: () => api.getOrder(orderId),
      enabled: Boolean(session),
    }),
    live,
  };
}

export function useOrderHistory() {
  const { session } = useAuth();
  return useInfiniteQuery({
    queryKey: queryKeys.orders,
    queryFn: ({ pageParam }) => api.listOrders(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: Boolean(session),
  });
}

export function useMe() {
  const { session } = useAuth();
  return useQuery({ queryKey: queryKeys.me, queryFn: api.getMe, enabled: Boolean(session) });
}
