import createClient from "openapi-fetch";
import {
  isApiErrorBody,
  type ApiErrorCode,
  type components,
  type paths,
} from "@campuscart/contracts";

export type Schemas = components["schemas"];

/** An API failure with the server's error code and machine-readable business reason. */
export class CampusCartApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "network_error",
    message: string,
    readonly reason: string | null = null,
    readonly requestId: string | null = null,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "CampusCartApiError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the current Supabase access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}

export function createApiClient({ baseUrl, getAccessToken, fetch }: ApiClientOptions) {
  const client = createClient<paths>({
    baseUrl: baseUrl.replace(/\/$/, ""),
    ...(fetch ? { fetch } : {}),
  });
  client.use({
    async onRequest({ request }) {
      const token = await getAccessToken();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  });
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Resolves to the response data or throws a CampusCartApiError. */
export async function unwrap<T>(call: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await call;
  } catch (cause) {
    throw new CampusCartApiError(0, "network_error", "Can't reach CampusCart", null, null, {
      cause: String(cause),
    });
  }
  const { data, error, response } = result;
  if (response.ok) return data as T;
  if (isApiErrorBody(error)) {
    const details =
      error.error.details && typeof error.error.details === "object"
        ? (error.error.details as Record<string, unknown>)
        : null;
    const reason = typeof details?.reason === "string" ? details.reason : null;
    throw new CampusCartApiError(
      response.status,
      error.error.code,
      error.error.message,
      reason,
      error.error.request_id,
      details,
    );
  }
  throw new CampusCartApiError(
    response.status,
    "internal_error",
    `Unexpected response (${response.status})`,
  );
}
