import type { components } from "./generated/api";

/**
 * Error envelope returned by every CampusCart API error response (services/api/app/core/errors.py).
 * The runtime list below is checked against the generated OpenAPI types at compile time.
 */
export const API_ERROR_CODES = [
  "validation_error",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "service_unavailable",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// Compile-time drift guard: fails `tsc` if the backend's error codes and this list diverge.
type GeneratedErrorCode = components["schemas"]["ErrorDetail"]["code"];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const errorCodesMatchBackend: Exact<ApiErrorCode, GeneratedErrorCode> = true;
void errorCodesMatchBackend;

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    request_id: string | null;
    details?: unknown;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    typeof message === "string" &&
    typeof code === "string" &&
    (API_ERROR_CODES as readonly string[]).includes(code)
  );
}
