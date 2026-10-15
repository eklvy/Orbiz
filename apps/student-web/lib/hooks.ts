"use client";

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
import { getApi } from "./api";
import { useAuth } from "./auth";
import { getSupabase } from "./supabase";

/** Outlets with live status: any outlet change triggers a refetch of the authoritative list. */
export function useOutlets() {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<RealtimeStatus>("connecting");
  useEffect(
    () =>
      subscribeToTable(getSupabase(), {
        table: "outlets",
        onChange: () => void queryClient.invalidateQueries({ queryKey: queryKeys.outlets }),
        onResync: () => void queryClient.invalidateQueries({ queryKey: queryKeys.outlets }),
        onStatus: setLive,
      }),
    [queryClient],
  );
  return {
    ...useQuery({ queryKey: queryKeys.outlets, queryFn: () => getApi().listOutlets() }),
    live,
  };
}

/** One outlet by id or slug (pass undefined until it is known), with live status. */
export function useOutlet(ref: string | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.outlet(ref ?? ""),
    queryFn: () => getApi().getOutlet(ref as string),
    enabled: Boolean(ref),
  });
  const outletId = query.data?.id;
  useEffect(() => {
    if (!outletId || !ref) return;
    return subscribeToTable(getSupabase(), {
      table: "outlets",
      filter: `id=eq.${outletId}`,
      onChange: () => void queryClient.invalidateQueries({ queryKey: queryKeys.outlet(ref) }),
    });
  }, [outletId, ref, queryClient]);
  return query;
}

/** Menu with live availability (stock and item changes refetch the menu). */
export function useMenu(outletId: string | undefined, filters: MenuFilters) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!outletId) return;
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.menuAll(outletId) });
    const offItems = subscribeToTable(getSupabase(), {
      table: "menu_items",
      filter: `outlet_id=eq.${outletId}`,
      onChange: refresh,
    });
    // inventory has no outlet column to filter on; refresh only for items on this menu.
    const offStock = subscribeToTable(getSupabase(), {
      table: "inventory",
      onChange: (payload) => {
        const itemId = (payload.new as { menu_item_id?: string } | null)?.menu_item_id;
        const menus = queryClient.getQueriesData<Schemas["Menu"]>({
          queryKey: queryKeys.menuAll(outletId),
        });
        const onMenu = menus.some(([, menu]) =>
          [
            ...(menu?.uncategorized ?? []),
            ...(menu?.categories.flatMap((c) => c.items) ?? []),
          ].some((item) => item.id === itemId),
        );
        if (onMenu) refresh();
      },
    });
    return () => {
      offItems();
      offStock();
    };
  }, [outletId, queryClient]);
  return useQuery({
    queryKey: queryKeys.menu(outletId ?? "", filters),
    queryFn: () => getApi().getMenu(outletId as string, filters),
    enabled: Boolean(outletId),
    placeholderData: (previous) => previous,
  });
}

export function usePickupSlots(outletId: string | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!outletId) return;
    return subscribeToTable(getSupabase(), {
      table: "pickup_slots",
      filter: `outlet_id=eq.${outletId}`,
      onChange: () => void queryClient.invalidateQueries({ queryKey: queryKeys.slots(outletId) }),
    });
  }, [outletId, queryClient]);
  return useQuery({
    queryKey: queryKeys.slots(outletId ?? ""),
    queryFn: () => getApi().listPickupSlots(outletId as string),
    enabled: Boolean(outletId),
    refetchInterval: 60_000, // slots move into the past even without database changes
  });
}

/**
 * Surplus deals on sale at an outlet (D-19). Realtime announces new deals; a deal that stops
 * being public (bought or expired) may not produce an event for this viewer, so the list is
 * also refreshed every 30 s.
 */
export function useDeals(outletId: string | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!outletId) return;
    return subscribeToTable(getSupabase(), {
      table: "surplus_deals",
      filter: `outlet_id=eq.${outletId}`,
      onChange: () => void queryClient.invalidateQueries({ queryKey: queryKeys.deals(outletId) }),
    });
  }, [outletId, queryClient]);
  return useQuery({
    queryKey: queryKeys.deals(outletId ?? ""),
    queryFn: () => getApi().listDeals(outletId as string),
    enabled: Boolean(outletId),
    refetchInterval: 30_000,
  });
}

export function useCart() {
  const { session } = useAuth();
  return useQuery({
    queryKey: queryKeys.cart,
    queryFn: () => getApi().getCart(),
    enabled: Boolean(session),
  });
}

export function useSetCartItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { menuItemId: string; quantity: number; replaceCart?: boolean }) =>
      vars.quantity > 0
        ? getApi().setCartItem(vars.menuItemId, vars.quantity, vars.replaceCart)
        : getApi().removeCartItem(vars.menuItemId),
    onSuccess: (cart) => queryClient.setQueryData(queryKeys.cart, cart),
  });
}

export function useTransitions() {
  return useQuery({
    queryKey: queryKeys.transitions,
    queryFn: () => getApi().listTransitions(),
    staleTime: Infinity,
  });
}

/**
 * One order, kept live: Realtime events trigger a refetch from the API (the authoritative
 * shape, including items and queue position), and stale/duplicate events are ignored.
 */
export function useOrder(orderId: string) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [live, setLive] = useState<RealtimeStatus>("connecting");
  useEffect(() => {
    if (!session) return;
    const key = queryKeys.order(orderId);
    return subscribeToTable(getSupabase(), {
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
      queryFn: () => getApi().getOrder(orderId),
      enabled: Boolean(session),
    }),
    live,
  };
}

export function useOrderHistory() {
  const { session } = useAuth();
  return useInfiniteQuery({
    queryKey: queryKeys.orders,
    queryFn: ({ pageParam }) => getApi().listOrders(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: Boolean(session),
  });
}

export function useMe() {
  const { session } = useAuth();
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getApi().getMe(),
    enabled: Boolean(session),
  });
}
