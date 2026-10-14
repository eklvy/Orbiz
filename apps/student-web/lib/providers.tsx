"use client";

import { CampusCartApiError } from "@campuscart/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { AuthProvider } from "./auth";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            // Don't hammer the API with retries for errors that won't fix themselves.
            retry: (count, error) =>
              count < 2 &&
              (!(error instanceof CampusCartApiError) || error.status === 0 || error.status >= 500),
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
