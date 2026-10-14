import { createApiClient, createStudentApi, type StudentApi } from "@campuscart/client";
import { env } from "./env";
import { getSupabase } from "./supabase";

let api: StudentApi | undefined;

export function getApi(): StudentApi {
  api ??= createStudentApi(
    createApiClient({
      baseUrl: env.apiBaseUrl,
      getAccessToken: async () =>
        (await getSupabase().auth.getSession()).data.session?.access_token ?? null,
    }),
  );
  return api;
}
