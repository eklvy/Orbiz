import { createApiClient, createStudentApi } from "@campuscart/client";
import { env } from "./env";
import { supabase } from "./supabase";

export const api = createStudentApi(
  createApiClient({
    baseUrl: env.apiBaseUrl,
    getAccessToken: async () =>
      (await supabase.auth.getSession()).data.session?.access_token ?? null,
  }),
);
