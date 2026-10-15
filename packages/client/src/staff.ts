import { unwrap, type ApiClient, type Schemas } from "./api";

export type StaffOrder = Schemas["StaffOrder"];
export type StaffDeal = Schemas["StaffDeal"];
export type ManagedOutlet = Schemas["ManagedOutlet"];
export type ManagerMenuItem = Schemas["ManagerMenuItem"];
export type StaffTargetStatus = Schemas["TransitionRequest"]["to_status"];

/** Query keys for the manager and kitchen dashboards. */
export const staffQueryKeys = {
  queue: (outletId: string) => ["staff-queue", outletId] as const,
  deals: (outletId: string) => ["staff-deals", outletId] as const,
  managedOutlets: ["managed-outlets"] as const,
  managedOutlet: (outletId: string) => ["managed-outlet", outletId] as const,
  summary: (outletId: string) => ["outlet-summary", outletId] as const,
  menu: (outletId: string) => ["manager-menu", outletId] as const,
  slots: (outletId: string, date: string) => ["manager-slots", outletId, date] as const,
  staff: (outletId: string) => ["outlet-staff", outletId] as const,
  refunds: (outletId: string) => ["refund-desk", outletId] as const,
  specials: (outletId: string) => ["manager-specials", outletId] as const,
  polls: (outletId: string) => ["manager-polls", outletId] as const,
  reviews: (outletId: string) => ["manager-reviews", outletId] as const,
  parties: (outletId: string) => ["manager-parties", outletId] as const,
};

/**
 * Typed calls for kitchen staff and managers. The server authorises every call; these only
 * shape requests. Prices are integer paise.
 */
export function createStaffApi(client: ApiClient) {
  const outlet = (outletId: string) => ({ params: { path: { outlet_id: outletId } } });
  return {
    getMe: () => unwrap(client.GET("/api/v1/me")),
    listOutlets: () => unwrap(client.GET("/api/v1/outlets")),
    listTransitions: () => unwrap(client.GET("/api/v1/orders/transitions")),

    // Kitchen / counter
    queue: (outletId: string, statuses?: Schemas["Order"]["status"][]) =>
      unwrap(
        client.GET("/api/v1/staff/outlets/{outlet_id}/orders", {
          params: {
            path: { outlet_id: outletId },
            query: statuses && statuses.length > 0 ? { status: statuses } : {},
          },
        }),
      ),
    transition: (orderId: string, toStatus: StaffTargetStatus, reason?: string) =>
      unwrap(
        client.POST("/api/v1/staff/orders/{order_id}/transition", {
          params: { path: { order_id: orderId } },
          body: { to_status: toStatus, ...(reason ? { reason } : {}) },
        }),
      ),
    verifyPickup: (orderId: string, code: string) =>
      unwrap(
        client.POST("/api/v1/staff/orders/{order_id}/verify-pickup", {
          params: { path: { order_id: orderId } },
          body: { code },
        }),
      ),
    deals: (outletId: string) =>
      unwrap(client.GET("/api/v1/staff/outlets/{outlet_id}/deals", outlet(outletId))),
    withdrawDeal: (dealId: string, reason: string) =>
      unwrap(
        client.POST("/api/v1/staff/deals/{deal_id}/withdraw", {
          params: { path: { deal_id: dealId } },
          body: { reason },
        }),
      ),

    // Manager: outlets
    managedOutlets: () => unwrap(client.GET("/api/v1/manage/outlets")),
    managedOutlet: (outletId: string) =>
      unwrap(client.GET("/api/v1/manage/outlets/{outlet_id}", outlet(outletId))),
    setStatus: (outletId: string, body: Schemas["OutletStatusUpdate"]) =>
      unwrap(
        client.POST("/api/v1/manage/outlets/{outlet_id}/status", { ...outlet(outletId), body }),
      ),
    updateSettings: (outletId: string, body: Schemas["OutletSettingsUpdate"]) =>
      unwrap(
        client.PATCH("/api/v1/manage/outlets/{outlet_id}/settings", { ...outlet(outletId), body }),
      ),
    setHours: (outletId: string, hours: Schemas["OpeningHoursIn"][]) =>
      unwrap(
        client.PUT("/api/v1/manage/outlets/{outlet_id}/hours", {
          ...outlet(outletId),
          body: { hours },
        }),
      ),
    summary: (outletId: string) =>
      unwrap(client.GET("/api/v1/manage/outlets/{outlet_id}/summary", outlet(outletId))),

    // Manager: menu and stock
    menu: (outletId: string) =>
      unwrap(client.GET("/api/v1/manage/outlets/{outlet_id}/menu", outlet(outletId))),
    createItem: (outletId: string, body: Schemas["MenuItemInput"]) =>
      unwrap(
        client.POST("/api/v1/manage/outlets/{outlet_id}/menu-items", { ...outlet(outletId), body }),
      ),
    updateItem: (itemId: string, body: Schemas["MenuItemInput"]) =>
      unwrap(
        client.PUT("/api/v1/manage/menu-items/{menu_item_id}", {
          params: { path: { menu_item_id: itemId } },
          body,
        }),
      ),
    setAvailability: (
      itemId: string,
      manualStatus: Schemas["AvailabilityUpdate"]["manual_status"],
    ) =>
      unwrap(
        client.PUT("/api/v1/manage/menu-items/{menu_item_id}/availability", {
          params: { path: { menu_item_id: itemId } },
          body: { manual_status: manualStatus },
        }),
      ),
    adjustStock: (itemId: string, body: Schemas["StockAdjustment"]) =>
      unwrap(
        client.POST("/api/v1/manage/menu-items/{menu_item_id}/stock-adjustments", {
          params: { path: { menu_item_id: itemId } },
          body,
        }),
      ),
    setStockTracking: (itemId: string, body: Schemas["StockTracking"]) =>
      unwrap(
        client.PUT("/api/v1/manage/menu-items/{menu_item_id}/stock-tracking", {
          params: { path: { menu_item_id: itemId } },
          body,
        }),
      ),
    createCategory: (outletId: string, body: Schemas["CategoryInput"]) =>
      unwrap(
        client.POST("/api/v1/manage/outlets/{outlet_id}/categories", { ...outlet(outletId), body }),
      ),
    updateCategory: (categoryId: string, body: Schemas["CategoryInput"]) =>
      unwrap(
        client.PUT("/api/v1/manage/categories/{category_id}", {
          params: { path: { category_id: categoryId } },
          body,
        }),
      ),
    deleteCategory: (categoryId: string) =>
      unwrap(
        client.DELETE("/api/v1/manage/categories/{category_id}", {
          params: { path: { category_id: categoryId } },
        }),
      ),

    // Manager: pickup slots
    slots: (outletId: string, date?: string) =>
      unwrap(
        client.GET("/api/v1/manage/outlets/{outlet_id}/pickup-slots", {
          params: { path: { outlet_id: outletId }, query: date ? { date } : {} },
        }),
      ),
    updateSlot: (slotId: string, body: Schemas["SlotUpdate"]) =>
      unwrap(
        client.PATCH("/api/v1/manage/pickup-slots/{slot_id}", {
          params: { path: { slot_id: slotId } },
          body,
        }),
      ),
    generateSlots: (outletId: string, date: string) =>
      unwrap(
        client.POST("/api/v1/manage/outlets/{outlet_id}/pickup-slots/generate", {
          ...outlet(outletId),
          body: { date },
        }),
      ),

    // Manager: staff
    staff: (outletId: string) =>
      unwrap(client.GET("/api/v1/manage/outlets/{outlet_id}/staff", outlet(outletId))),
    addStaff: (outletId: string, email: string) =>
      unwrap(
        client.POST("/api/v1/manage/outlets/{outlet_id}/staff", {
          ...outlet(outletId),
          body: { email, role: "kitchen_staff" },
        }),
      ),
    removeStaff: (outletId: string, userId: string) =>
      unwrap(
        client.DELETE("/api/v1/manage/outlets/{outlet_id}/staff/{user_id}", {
          params: { path: { outlet_id: outletId, user_id: userId } },
        }),
      ),

    // Manager: refunds desk
    refunds: (outletId: string) =>
      unwrap(client.GET("/api/v1/manage/outlets/{outlet_id}/refunds", outlet(outletId))),
    decideRefund: (requestId: string, body: Schemas["RefundDecision"]) =>
      unwrap(
        client.POST("/api/v1/manage/refund-requests/{request_id}/decision", {
          params: { path: { request_id: requestId } },
          body,
        }),
      ),
    // Manager: specials, polls, reviews, party bookings (Phase 5)
    specials: (outletId: string) =>
      unwrap(client.GET("/api/v1/manage/outlets/{outlet_id}/specials", outlet(outletId))),
    saveSpecial: (outletId: string, body: Schemas["SpecialInput"]) =>
      unwrap(
        client.PUT("/api/v1/manage/outlets/{outlet_id}/specials", { ...outlet(outletId), body }),
      ),
    deleteSpecial: (specialId: string) =>
      unwrap(
        client.DELETE("/api/v1/manage/specials/{special_id}", {
          params: { path: { special_id: specialId } },
        }),
      ),
    polls: (outletId: string) =>
      unwrap(client.GET("/api/v1/outlets/{outlet_id}/polls", outlet(outletId))),
    createPoll: (outletId: string, body: Schemas["PollInput"]) =>
      unwrap(
        client.POST("/api/v1/manage/outlets/{outlet_id}/polls", { ...outlet(outletId), body }),
      ),
    closePoll: (pollId: string) =>
      unwrap(
        client.POST("/api/v1/manage/polls/{poll_id}/close", {
          params: { path: { poll_id: pollId } },
        }),
      ),
    publishPoll: (pollId: string, optionId?: string) =>
      unwrap(
        client.POST("/api/v1/manage/polls/{poll_id}/publish", {
          params: { path: { poll_id: pollId } },
          body: optionId ? { option_id: optionId } : {},
        }),
      ),
    reviews: (outletId: string, needsReply = false) =>
      unwrap(
        client.GET("/api/v1/outlets/{outlet_id}/reviews", {
          params: { path: { outlet_id: outletId }, query: { needs_reply: needsReply, limit: 100 } },
        }),
      ),
    replyToReview: (reviewId: string, reply: string) =>
      unwrap(
        client.POST("/api/v1/staff/reviews/{review_id}/reply", {
          params: { path: { review_id: reviewId } },
          body: { reply },
        }),
      ),
    ratings: () => unwrap(client.GET("/api/v1/ratings")),
    parties: (outletId: string) =>
      unwrap(client.GET("/api/v1/manage/outlets/{outlet_id}/parties", outlet(outletId))),
    decideParty: (bookingId: string, accept: boolean, note?: string) =>
      unwrap(
        client.POST("/api/v1/manage/parties/{booking_id}/decision", {
          params: { path: { booking_id: bookingId } },
          body: { accept, ...(note ? { note } : {}) },
        }),
      ),
    fulfilParty: (bookingId: string) =>
      unwrap(
        client.POST("/api/v1/manage/parties/{booking_id}/fulfil", {
          params: { path: { booking_id: bookingId } },
        }),
      ),

    approveAllRefunds: (outletId: string) =>
      unwrap(
        client.POST("/api/v1/manage/outlets/{outlet_id}/refunds/approve-all", outlet(outletId)),
      ),
  };
}

export type StaffApi = ReturnType<typeof createStaffApi>;

/** Outlets where the signed-in user works, from GET /me (kitchen staff and managers). */
export function staffOutlets(me: Schemas["Me"]): Schemas["OutletMembership"][] {
  return me.outlet_roles;
}

/** Whether the user manages any outlet (or is an admin); the server re-checks every call. */
export function canManage(me: Schemas["Me"], outletId?: string): boolean {
  if (me.platform_roles.includes("admin")) return true;
  return me.outlet_roles.some(
    (m) => m.role === "manager" && (outletId === undefined || m.outlet_id === outletId),
  );
}
