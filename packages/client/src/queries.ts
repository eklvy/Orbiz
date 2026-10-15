import { unwrap, type ApiClient, type Schemas } from "./api";

export interface MenuFilters {
  categoryId?: string;
  diet?: Schemas["MenuItem"]["diet"];
  maxPricePaise?: number;
  search?: string;
  availableOnly?: boolean;
}

/** TanStack Query keys shared by every client, so invalidation is consistent. */
export const queryKeys = {
  outlets: ["outlets"] as const,
  outlet: (ref: string) => ["outlet", ref] as const,
  menu: (outletId: string, filters: MenuFilters = {}) => ["menu", outletId, filters] as const,
  menuAll: (outletId: string) => ["menu", outletId] as const,
  slots: (outletId: string) => ["slots", outletId] as const,
  cart: ["cart"] as const,
  orders: ["orders"] as const,
  order: (orderId: string) => ["order", orderId] as const,
  transitions: ["order-transitions"] as const,
  me: ["me"] as const,
  deals: (outletId: string) => ["deals", outletId] as const,
  paymentsConfig: ["payments-config"] as const,
  wallet: ["wallet"] as const,
  loyalty: ["loyalty"] as const,
  budget: ["budget"] as const,
  notifications: ["notifications"] as const,
  specials: (outletId: string) => ["specials", outletId] as const,
  polls: (outletId: string) => ["polls", outletId] as const,
  myVotes: (outletId: string) => ["my-votes", outletId] as const,
  reviews: (outletId: string) => ["reviews", outletId] as const,
  orderReview: (orderId: string) => ["order-review", orderId] as const,
  ratings: ["ratings"] as const,
  popular: ["popular"] as const,
  groups: ["groups"] as const,
  group: (groupId: string) => ["group", groupId] as const,
  parties: ["parties"] as const,
  splits: ["splits"] as const,
};

/** Typed calls for every student-facing endpoint. Prices and totals are never sent. */
export function createStudentApi(client: ApiClient) {
  return {
    listOutlets: () => unwrap(client.GET("/api/v1/outlets")),
    getOutlet: (ref: string) =>
      unwrap(client.GET("/api/v1/outlets/{outlet_ref}", { params: { path: { outlet_ref: ref } } })),
    getMenu: (outletId: string, filters: MenuFilters = {}) =>
      unwrap(
        client.GET("/api/v1/outlets/{outlet_id}/menu", {
          params: {
            path: { outlet_id: outletId },
            query: {
              ...(filters.categoryId ? { category_id: filters.categoryId } : {}),
              ...(filters.diet ? { diet: filters.diet } : {}),
              ...(filters.maxPricePaise ? { max_price_paise: filters.maxPricePaise } : {}),
              ...(filters.search ? { q: filters.search } : {}),
              ...(filters.availableOnly ? { available_only: true } : {}),
            },
          },
        }),
      ),
    listPickupSlots: (outletId: string) =>
      unwrap(
        client.GET("/api/v1/outlets/{outlet_id}/pickup-slots", {
          params: { path: { outlet_id: outletId } },
        }),
      ),
    getCart: () => unwrap(client.GET("/api/v1/cart")),
    setCartItem: (menuItemId: string, quantity: number, replaceCart = false) =>
      unwrap(
        client.PUT("/api/v1/cart/items/{menu_item_id}", {
          params: { path: { menu_item_id: menuItemId } },
          body: { quantity, replace_cart: replaceCart },
        }),
      ),
    removeCartItem: (menuItemId: string) =>
      unwrap(
        client.DELETE("/api/v1/cart/items/{menu_item_id}", {
          params: { path: { menu_item_id: menuItemId } },
        }),
      ),
    clearCart: () => unwrap(client.DELETE("/api/v1/cart")),
    placeOrder: (body: Schemas["OrderCreate"], idempotencyKey: string) =>
      unwrap(
        client.POST("/api/v1/orders", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    listOrders: (cursor?: string | null, limit = 20) =>
      unwrap(
        client.GET("/api/v1/orders", {
          params: { query: { limit, ...(cursor ? { cursor } : {}) } },
        }),
      ),
    getOrder: (orderId: string) =>
      unwrap(client.GET("/api/v1/orders/{order_id}", { params: { path: { order_id: orderId } } })),
    cancelOrder: (orderId: string, reason?: string) =>
      unwrap(
        client.POST("/api/v1/orders/{order_id}/cancel", {
          params: { path: { order_id: orderId } },
          body: reason ? { reason } : {},
        }),
      ),
    requestRefund: (orderId: string, reason: string) =>
      unwrap(
        client.POST("/api/v1/orders/{order_id}/refund-request", {
          params: { path: { order_id: orderId } },
          body: { reason },
        }),
      ),
    listDeals: (outletId: string) =>
      unwrap(
        client.GET("/api/v1/outlets/{outlet_id}/deals", {
          params: { path: { outlet_id: outletId } },
        }),
      ),
    claimDeal: (dealId: string, idempotencyKey: string) =>
      unwrap(
        client.POST("/api/v1/deals/{deal_id}/claim", {
          params: { path: { deal_id: dealId }, header: { "Idempotency-Key": idempotencyKey } },
        }),
      ),
    listTransitions: () => unwrap(client.GET("/api/v1/orders/transitions")),

    // Payments and wallet (Phase 5). Amounts for orders are always read by the server.
    paymentsConfig: () => unwrap(client.GET("/api/v1/payments/config")),
    getWallet: (cursor?: number | null) =>
      unwrap(client.GET("/api/v1/wallet", { params: { query: cursor ? { cursor } : {} } })),
    payWithWallet: (orderId: string) =>
      unwrap(
        client.POST("/api/v1/orders/{order_id}/pay-with-wallet", {
          params: { path: { order_id: orderId } },
        }),
      ),
    startCheckout: (body: Schemas["CheckoutRequest"]) =>
      unwrap(client.POST("/api/v1/payments/razorpay/checkout", { body })),
    verifyCheckout: (body: Schemas["CheckoutVerification"]) =>
      unwrap(client.POST("/api/v1/payments/razorpay/verify", { body })),

    // Loyalty, vouchers, budget
    getLoyalty: () => unwrap(client.GET("/api/v1/loyalty")),
    redeemVoucher: () => unwrap(client.POST("/api/v1/loyalty/vouchers")),
    applyVoucher: (orderId: string, code: string) =>
      unwrap(
        client.POST("/api/v1/orders/{order_id}/voucher", {
          params: { path: { order_id: orderId } },
          body: { code },
        }),
      ),
    getBudget: () => unwrap(client.GET("/api/v1/budget")),
    setBudget: (body: Schemas["BudgetUpdate"]) => unwrap(client.PUT("/api/v1/budget", { body })),
    clearBudget: () => unwrap(client.DELETE("/api/v1/budget")),

    // Notifications
    listNotifications: (before?: string | null) =>
      unwrap(client.GET("/api/v1/notifications", { params: { query: before ? { before } : {} } })),
    markNotificationsRead: (ids?: string[]) =>
      unwrap(client.POST("/api/v1/notifications/read", { body: ids ? { ids } : {} })),
    registerPushToken: (token: string, platform: "ios" | "android") =>
      unwrap(client.POST("/api/v1/notifications/push-tokens", { body: { token, platform } })),

    // Specials, polls, reviews, popular
    listSpecials: (outletId: string) =>
      unwrap(
        client.GET("/api/v1/outlets/{outlet_id}/specials", {
          params: { path: { outlet_id: outletId } },
        }),
      ),
    listPolls: (outletId: string) =>
      unwrap(
        client.GET("/api/v1/outlets/{outlet_id}/polls", {
          params: { path: { outlet_id: outletId } },
        }),
      ),
    myVotes: (outletId: string) =>
      unwrap(
        client.GET("/api/v1/outlets/{outlet_id}/polls/my-votes", {
          params: { path: { outlet_id: outletId } },
        }),
      ),
    vote: (pollId: string, optionId: string) =>
      unwrap(
        client.POST("/api/v1/polls/{poll_id}/vote", {
          params: { path: { poll_id: pollId } },
          body: { option_id: optionId },
        }),
      ),
    listReviews: (outletId: string) =>
      unwrap(
        client.GET("/api/v1/outlets/{outlet_id}/reviews", {
          params: { path: { outlet_id: outletId } },
        }),
      ),
    getOrderReview: (orderId: string) =>
      unwrap(
        client.GET("/api/v1/orders/{order_id}/review", { params: { path: { order_id: orderId } } }),
      ),
    submitReview: (orderId: string, body: Schemas["ReviewInput"]) =>
      unwrap(
        client.POST("/api/v1/orders/{order_id}/review", {
          params: { path: { order_id: orderId } },
          body,
        }),
      ),
    ratings: () => unwrap(client.GET("/api/v1/ratings")),
    popular: () => unwrap(client.GET("/api/v1/popular")),

    // Group orders, party bookings, bill splits
    listGroups: () => unwrap(client.GET("/api/v1/groups")),
    getGroup: (groupId: string) =>
      unwrap(client.GET("/api/v1/groups/{group_id}", { params: { path: { group_id: groupId } } })),
    createGroup: (outletId: string, pickupSlotId: string) =>
      unwrap(
        client.POST("/api/v1/groups", {
          body: { outlet_id: outletId, pickup_slot_id: pickupSlotId },
        }),
      ),
    joinGroup: (code: string) => unwrap(client.POST("/api/v1/groups/join", { body: { code } })),
    setGroupItem: (groupId: string, body: Schemas["GroupItemSet"]) =>
      unwrap(
        client.PUT("/api/v1/groups/{group_id}/items", {
          params: { path: { group_id: groupId } },
          body,
        }),
      ),
    setGroupSplit: (groupId: string, body: Schemas["GroupSplit"]) =>
      unwrap(
        client.PUT("/api/v1/groups/{group_id}/split", {
          params: { path: { group_id: groupId } },
          body,
        }),
      ),
    checkoutGroup: (groupId: string) =>
      unwrap(
        client.POST("/api/v1/groups/{group_id}/checkout", {
          params: { path: { group_id: groupId } },
        }),
      ),
    payGroupShare: (groupId: string) =>
      unwrap(
        client.POST("/api/v1/groups/{group_id}/pay", { params: { path: { group_id: groupId } } }),
      ),
    leaveGroup: (groupId: string) =>
      unwrap(
        client.POST("/api/v1/groups/{group_id}/leave", { params: { path: { group_id: groupId } } }),
      ),
    listParties: () => unwrap(client.GET("/api/v1/parties")),
    requestParty: (body: Schemas["PartyRequest"]) =>
      unwrap(client.POST("/api/v1/parties", { body })),
    payParty: (bookingId: string) =>
      unwrap(
        client.POST("/api/v1/parties/{booking_id}/pay", {
          params: { path: { booking_id: bookingId } },
        }),
      ),
    cancelParty: (bookingId: string) =>
      unwrap(
        client.POST("/api/v1/parties/{booking_id}/cancel", {
          params: { path: { booking_id: bookingId } },
        }),
      ),
    listSplits: () => unwrap(client.GET("/api/v1/splits")),
    createSplit: (body: Schemas["SplitCreate"]) => unwrap(client.POST("/api/v1/splits", { body })),
    settleSplit: (splitId: string) =>
      unwrap(
        client.POST("/api/v1/splits/{split_id}/settle", {
          params: { path: { split_id: splitId } },
        }),
      ),
    cancelSplit: (splitId: string) =>
      unwrap(
        client.POST("/api/v1/splits/{split_id}/cancel", {
          params: { path: { split_id: splitId } },
        }),
      ),

    getMe: () => unwrap(client.GET("/api/v1/me")),
    updateMe: (body: Schemas["ProfileUpdate"]) => unwrap(client.PATCH("/api/v1/me", { body })),
  };
}

export type StudentApi = ReturnType<typeof createStudentApi>;
