import { describe, expect, it } from "vitest";
import { isApiErrorBody } from "./errors";

describe("isApiErrorBody", () => {
  it("accepts a well-formed error envelope", () => {
    expect(
      isApiErrorBody({ error: { code: "not_found", message: "Missing", request_id: "abc" } }),
    ).toBe(true);
  });

  it("rejects unknown error codes", () => {
    expect(isApiErrorBody({ error: { code: "teapot", message: "x", request_id: null } })).toBe(
      false,
    );
  });

  it("rejects non-envelope values", () => {
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody({ message: "x" })).toBe(false);
    expect(isApiErrorBody({ error: "x" })).toBe(false);
  });
});
