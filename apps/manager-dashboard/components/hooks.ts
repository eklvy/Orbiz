"use client";

import { staffQueryKeys, subscribeToTable } from "@campuscart/client";
import { useCurrentOutlet, useRuntime } from "@campuscart/staff-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/** The selected outlet's settings, hours and live load (refetched on any outlet change). */
export function useManagedOutlet() {
  const { outlet } = useCurrentOutlet();
  const { api, supabase } = useRuntime();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeToTable(supabase, {
        table: "outlets",
        filter: `id=eq.${outlet.id}`,
        onChange: () => {
          void queryClient.invalidateQueries({ queryKey: staffQueryKeys.managedOutlet(outlet.id) });
          void queryClient.invalidateQueries({ queryKey: staffQueryKeys.managedOutlets });
        },
      }),
    [supabase, outlet.id, queryClient],
  );
  return useQuery({
    queryKey: staffQueryKeys.managedOutlet(outlet.id),
    queryFn: () => api.managedOutlet(outlet.id),
  });
}

/** Manager menu with stock and today's counts; stock, item and order changes refetch it. */
export function useManagerMenu() {
  const { outlet } = useCurrentOutlet();
  const { api, supabase } = useRuntime();
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.menu(outlet.id) });
    const offs = [
      subscribeToTable(supabase, {
        table: "menu_items",
        filter: `outlet_id=eq.${outlet.id}`,
        onChange: refresh,
      }),
      // inventory has no outlet column; any stock change refetches (cheap, manager-only view).
      subscribeToTable(supabase, { table: "inventory", onChange: refresh }),
      subscribeToTable(supabase, {
        table: "orders",
        filter: `outlet_id=eq.${outlet.id}`,
        onChange: refresh,
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [supabase, outlet.id, queryClient]);
  return useQuery({
    queryKey: staffQueryKeys.menu(outlet.id),
    queryFn: () => api.menu(outlet.id),
  });
}
