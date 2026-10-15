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
    getMe: () => unwrap(client.GET("/api/v1/me")),
    updateMe: (body: Schemas["ProfileUpdate"]) => unwrap(client.PATCH("/api/v1/me", { body })),
  };
}

export type StudentApi = ReturnType<typeof createStudentApi>;
