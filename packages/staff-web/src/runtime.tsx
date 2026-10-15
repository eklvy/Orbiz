"use client";

import {
  CampusCartApiError,
  createApiClient,
  createStaffApi,
  queryKeys,
  type Schemas,
  type StaffApi,
} from "@campuscart/client";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface StaffConfig {
  apiBaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface StaffRuntime {
  supabase: SupabaseClient;
  api: StaffApi;
}

/** Browser Supabase client (session + Realtime) and the typed staff API, created once. */
export function createStaffRuntime(config: StaffConfig): StaffRuntime {
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const api = createStaffApi(
    createApiClient({
      baseUrl: config.apiBaseUrl,
      getAccessToken: async () =>
        (await supabase.auth.getSession()).data.session?.access_token ?? null,
    }),
  );
  return { supabase, api };
}

const RuntimeContext = createContext<StaffRuntime | null>(null);

export function useRuntime(): StaffRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("useRuntime must be used inside StaffProviders");
  return runtime;
}

interface AuthState {
  session: Session | null;
  /** False until the stored session has been read; avoids flashing the sign-in form. */
  ready: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function AuthProvider({ children }: { children: ReactNode }) {
  const { supabase } = useRuntime();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setReady(true);
      if (event === "SIGNED_OUT") queryClient.clear();
    });
    return () => data.subscription.unsubscribe();
  }, [supabase, queryClient]);
  const signOut = async () => {
    await supabase.auth.signOut();
  };
  return (
    <AuthContext.Provider value={{ session, ready, signOut }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error("useAuth must be used inside StaffProviders");
  return state;
}

/** The signed-in user's profile and outlet roles (authoritative: GET /me). */
export function useMe() {
  const { session } = useAuth();
  const { api } = useRuntime();
  return useQuery<Schemas["Me"]>({
    queryKey: queryKeys.me,
    queryFn: () => api.getMe(),
    enabled: Boolean(session),
    staleTime: 60_000,
  });
}

let browserRuntime: StaffRuntime | undefined;
const noSubscription = () => () => undefined;

/**
 * Query cache, runtime and auth for a dashboard. Everything is behind sign-in, so nothing is
 * rendered on the server: the runtime (and its env check) is created once, in the browser.
 */
export function StaffProviders({
  runtime,
  children,
}: {
  runtime: () => StaffRuntime;
  children: ReactNode;
}) {
  const inBrowser = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: (count, error) =>
              count < 2 &&
              (!(error instanceof CampusCartApiError) || error.status === 0 || error.status >= 500),
          },
        },
      }),
  );
  if (!inBrowser) return null;
  browserRuntime ??= runtime();
  return (
    <RuntimeContext.Provider value={browserRuntime}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </RuntimeContext.Provider>
  );
}
