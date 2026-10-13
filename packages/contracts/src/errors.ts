/**
 * Error envelope returned by every CampusCart API error response.
 * Mirrors `ErrorResponse` in services/api/app/core/errors.py — keep them in sync
 * until types are generated from the OpenAPI schema (see docs/ARCHITECTURE.md §7).
 */
export const API_ERROR_CODES = [
  "validation_error",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

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
