import { describe, expect, it } from "vitest";
import {
  CampusCartApiError,
  canTransition,
  createApiClient,
  createStudentApi,
  formatCountdown,
  formatDayLabel,
  formatPaise,
  formatSlot,
  friendlyError,
  isNewerVersion,
  newIdempotencyKey,
  orderTimeline,
  pickupQrPayload,
  profileUpdate,
  registerSchema,
  registrationMetadata,
  type TransitionRule,
} from "./index";

const rule = (from: string, to: string, actor: string, requiresPaid = false) =>
  ({
    from_status: from,
    to_status: to,
    actor,
    requires_paid: requiresPaid,
    requires_reason: false,
    requires_pickup_code: false,
    releases_stock: false,
    releases_slot: false,
    marks_refund_required: false,
    description: "",
  }) as TransitionRule;

describe("formatting", () => {
  it("formats paise as rupees", () => {
    expect(formatPaise(7000)).toBe("₹70");
    expect(formatPaise(7050)).toBe("₹70.50");
    expect(formatPaise(120000)).toBe("₹1,200");
  });

  it("formats slots and day labels in the outlet time zone", () => {
    const now = new Date("2026-10-14T05:00:00Z"); // 10:30 IST
    expect(formatSlot("2026-10-14T07:45:00Z", "2026-10-14T08:00:00Z", "Asia/Kolkata")).toMatch(
      /1:15.*pm – 1:30.*pm/i,
    );
    expect(formatDayLabel("2026-10-14T07:45:00Z", "Asia/Kolkata", now)).toBe("Today");
    expect(formatDayLabel("2026-10-15T07:45:00Z", "Asia/Kolkata", now)).toBe("Tomorrow");
    // 19:00 UTC on the 14th is already the 15th in IST.
    expect(formatDayLabel("2026-10-14T19:00:00Z", "Asia/Kolkata", now)).toBe("Tomorrow");
  });

  it("formats countdowns and never goes negative", () => {
    expect(formatCountdown(9 * 60_000 + 5_000)).toBe("9:05");
    expect(formatCountdown(-1)).toBe("0:00");
  });
});

describe("orders", () => {
  it("builds a timeline from the status", () => {
    expect(orderTimeline("preparing").map((s) => s.state)).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(orderTimeline("payment_pending").every((s) => s.state === "upcoming")).toBe(true);
    expect(orderTimeline("completed").every((s) => s.state === "done")).toBe(true);
    expect(orderTimeline("cancelled")).toEqual([]);
  });

  it("decides allowed actions from the server's rule table", () => {
    const rules = [
      rule("payment_pending", "cancelled", "student"),
      rule("placed", "cancelled", "student", true),
      rule("placed", "confirmed", "staff", true),
    ];
    expect(
      canTransition(
        rules,
        { status: "payment_pending", payment_status: "unpaid" },
        "cancelled",
        "student",
      ),
    ).toBe(true);
    expect(
      canTransition(rules, { status: "placed", payment_status: "paid" }, "cancelled", "student"),
    ).toBe(true);
    expect(
      canTransition(rules, { status: "placed", payment_status: "paid" }, "confirmed", "student"),
    ).toBe(false);
    expect(
      canTransition(rules, { status: "confirmed", payment_status: "paid" }, "cancelled", "student"),
    ).toBe(false);
  });

  it("ignores stale or duplicate realtime versions", () => {
    expect(isNewerVersion(undefined, { version: 1 })).toBe(true);
    expect(isNewerVersion({ version: 3 }, { version: 3 })).toBe(false);
    expect(isNewerVersion({ version: 3 }, { version: 2 })).toBe(false);
    expect(isNewerVersion({ version: 3 }, { version: 4 })).toBe(true);
  });

  it("builds the pickup QR payload only when a code exists", () => {
    expect(pickupQrPayload({ id: "o1", pickup_code: "ABC234" })).toBe(
      "campuscart:pickup:o1:ABC234",
    );
    expect(pickupQrPayload({ id: "o1", pickup_code: null })).toBeNull();
  });
});

describe("validation", () => {
  const base = {
    fullName: "Asha",
    email: "asha@campus.test",
    password: "secret123",
    customerType: "student" as const,
    rollNumber: "CS-2024/17",
    department: "",
    yearOfStudy: "2",
  };

  it("accepts a valid student and maps it to signup metadata", () => {
    const parsed = registerSchema.parse(base);
    expect(registrationMetadata(parsed)).toEqual({
      full_name: "Asha",
      customer_type: "student",
      roll_number: "CS-2024/17",
      year_of_study: "2",
    });
  });

  it("mirrors the database and password rules", () => {
    expect(registerSchema.safeParse({ ...base, rollNumber: "" }).success).toBe(false);
    expect(
      registerSchema.safeParse({ ...base, customerType: "faculty", rollNumber: "" }).success,
    ).toBe(true);
    expect(registerSchema.safeParse({ ...base, rollNumber: "x; drop" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, password: "short1" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, password: "lettersonly" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, yearOfStudy: "9" }).success).toBe(false);
  });

  it("clears optional profile fields with null", () => {
    expect(
      profileUpdate({ fullName: " Asha ", department: "", yearOfStudy: "", hostelRoom: "H-7" }),
    ).toEqual({
      full_name: "Asha",
      department: null,
      year_of_study: null,
      hostel_room: "H-7",
    });
  });
});

describe("api client", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("sends the bearer token and returns data", async () => {
    let seen: string | null = null;
    const api = createStudentApi(
      createApiClient({
        baseUrl: "http://api.test/",
        getAccessToken: async () => "tok",
        fetch: async (input) => {
          seen = (input as Request).headers.get("Authorization");
          return json(200, { outlet_id: null, items: [], subtotal_paise: 0, item_count: 0 });
        },
      }),
    );
    await expect(api.getCart()).resolves.toMatchObject({ item_count: 0 });
    expect(seen).toBe("Bearer tok");
  });

  it("turns the error envelope into CampusCartApiError with the reason", async () => {
    const api = createStudentApi(
      createApiClient({
        baseUrl: "http://api.test",
        getAccessToken: async () => null,
        fetch: async () =>
          json(409, {
            error: {
              code: "conflict",
              message: "Not enough Chai left",
              request_id: "r1",
              details: { reason: "insufficient_stock" },
            },
          }),
      }),
    );
    const error = await api.getCart().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CampusCartApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      reason: "insufficient_stock",
      requestId: "r1",
    });
    expect(friendlyError(error)).toEqual({
      message: "Not enough Chai left",
      hint: "Lower the quantity or choose something else.",
    });
  });

  it("reports network failures distinctly", async () => {
    const api = createStudentApi(
      createApiClient({
        baseUrl: "http://api.test",
        getAccessToken: async () => null,
        fetch: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    );
    const error = await api.listOutlets().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: "network_error" });
    expect(friendlyError(error).message).toBe("Can't reach CampusCart.");
  });

  it("creates unique idempotency keys", () => {
    const keys = new Set(Array.from({ length: 100 }, newIdempotencyKey));
    expect(keys.size).toBe(100);
    expect([...keys][0]).toMatch(/^checkout-.{8,}/);
  });
});
