import {
  CampusCartApiError,
  formatPaise,
  type MenuFilters,
  type Schemas,
} from "@campuscart/client";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  Muted,
  Stepper,
  makeStyles,
} from "@/components/ui";
import { DealsList } from "@/components/deals";
import { useAuth } from "@/lib/auth";
import { confirm } from "@/lib/confirm";
import { useCart, useMenu, useOutlet, useSetCartItem } from "@/lib/hooks";
import { radius, space, useTheme } from "@/lib/theme";

const DIETS: { value: MenuFilters["diet"] | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "veg", label: "Veg" },
  { value: "egg", label: "Egg" },
  { value: "non_veg", label: "Non-veg" },
];

function StockBadge({ item }: { item: Schemas["MenuItem"] }) {
  if (item.stock_status === "sold_out") return <Badge tone="danger" label="Sold out" />;
  if (item.stock_status === "low")
    return (
      <Badge
        tone="warning"
        label={
          item.quantity_available != null ? `Only ${item.quantity_available} left` : "Running low"
        }
      />
    );
  return null;
}

export default function OutletScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { session } = useAuth();
  const outlet = useOutlet(slug);
  const [search, setSearch] = useState("");
  const [diet, setDiet] = useState<MenuFilters["diet"]>();
  const [availableOnly, setAvailableOnly] = useState(false);
  const filters = useMemo<MenuFilters>(
    () => ({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(diet ? { diet } : {}),
      ...(availableOnly ? { availableOnly } : {}),
    }),
    [search, diet, availableOnly],
  );
  const menu = useMenu(outlet.data?.id, filters);
  const cart = useCart();
  const setItem = useSetCartItem();
  const [pending, setPending] = useState<string | null>(null);

  if (outlet.isPending) return <Loading label="Loading outlet" />;
  if (outlet.isError)
    return <ErrorBox error={outlet.error} onRetry={() => void outlet.refetch()} />;
  const o = outlet.data;
  const items = menu.data
    ? [...menu.data.categories.flatMap((c) => c.items), ...menu.data.uncategorized]
    : [];
  const quantities = new Map(
    cart.data?.outlet_id === o.id ? cart.data.items.map((i) => [i.menu_item_id, i.quantity]) : [],
  );

  async function change(item: Schemas["MenuItem"], quantity: number) {
    if (!session) {
      router.push("/login");
      return;
    }
    setPending(item.id);
    try {
      await setItem.mutateAsync({ menuItemId: item.id, quantity });
    } catch (error) {
      if (
        error instanceof CampusCartApiError &&
        error.reason === "cart_outlet_mismatch" &&
        (await confirm(
          "Start a new cart?",
          "Your cart has items from another outlet.",
          "Start new cart",
        ))
      ) {
        await setItem.mutateAsync({ menuItemId: item.id, quantity, replaceCart: true });
      }
    } finally {
      setPending(null);
    }
  }

  const cartHere =
    cart.data && cart.data.outlet_id === o.id && cart.data.item_count > 0 ? cart.data : null;
  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: o.name }} />
      <ScrollView contentContainerStyle={s.content}>
        <Muted>
          {o.location ?? ""} · ~{o.queue.estimated_wait_minutes} min wait · {o.queue.active_orders}{" "}
          in queue
        </Muted>
        {!o.accepting_orders && (
          <View style={{ backgroundColor: t.warnSoft, padding: space.md, borderRadius: radius.sm }}>
            <Text style={{ color: t.warn, fontWeight: "600" }}>
              {o.status === "on_break" ? "On a break" : "Closed"} — not taking orders right now.
            </Text>
            {o.status_reason && <Text style={{ color: t.warn }}>“{o.status_reason}”</Text>}
          </View>
        )}
        <DealsList outletId={o.id} timeZone={o.timezone} />
        <TextInput
          accessibilityLabel="Search the menu"
          placeholder="Search the menu"
          placeholderTextColor={t.muted}
          value={search}
          onChangeText={setSearch}
          maxLength={60}
          style={{
            minHeight: 48,
            borderWidth: 1,
            borderColor: t.line,
            borderRadius: radius.sm,
            paddingHorizontal: space.md,
            color: t.ink,
            backgroundColor: t.surface,
          }}
        />
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}
        >
          {DIETS.map((d) => (
            <Pressable
              key={d.label}
              accessibilityRole="button"
              accessibilityState={{ selected: diet === d.value }}
              onPress={() => setDiet(d.value)}
              style={{
                minHeight: 36,
                paddingHorizontal: space.md,
                justifyContent: "center",
                borderRadius: 999,
                borderWidth: 1,
                borderColor: diet === d.value ? t.primary : t.line,
                backgroundColor: diet === d.value ? t.primarySoft : t.surface,
              }}
            >
              <Text style={{ color: diet === d.value ? t.primary : t.ink }}>{d.label}</Text>
            </Pressable>
          ))}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Switch
              accessibilityLabel="Available only"
              value={availableOnly}
              onValueChange={setAvailableOnly}
            />
            <Text style={{ color: t.ink }}>Available only</Text>
          </View>
        </View>
        <ErrorBox error={setItem.error} />
        {menu.isPending ? (
          <Loading label="Loading menu" />
        ) : menu.isError ? (
          <ErrorBox error={menu.error} onRetry={() => void menu.refetch()} />
        ) : items.length === 0 ? (
          <Empty title="Nothing to show" message="Try different filters." />
        ) : (
          items.map((item) => {
            const qty = quantities.get(item.id) ?? 0;
            const soldOut = item.stock_status === "sold_out";
            return (
              <Card key={item.id}>
                <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                  {item.diet && (
                    <Text
                      style={{
                        color: item.diet === "non_veg" ? t.danger : t.ok,
                        fontSize: 12,
                        fontWeight: "700",
                      }}
                    >
                      {{ veg: "Veg", egg: "Egg", non_veg: "Non-veg" }[item.diet]}
                    </Text>
                  )}
                  <StockBadge item={item} />
                </View>
                <Text style={{ color: t.ink, fontSize: 16, fontWeight: "700" }}>{item.name}</Text>
                {item.description && <Muted>{item.description}</Muted>}
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <View>
                    <Text style={{ color: t.ink, fontWeight: "700" }}>
                      {formatPaise(item.price_paise)}
                    </Text>
                    <Text style={{ color: t.muted, fontSize: 12 }}>
                      {item.prep_minutes} min
                      {item.calories_kcal != null ? ` · ${item.calories_kcal} kcal` : ""}
                      {item.protein_g != null ? ` · ${item.protein_g} g protein` : ""}
                    </Text>
                  </View>
                  {qty > 0 ? (
                    <Stepper
                      value={qty}
                      label={item.name}
                      disabled={pending === item.id}
                      max={Math.min(20, item.quantity_available ?? 20)}
                      onChange={(q) => void change(item, q)}
                    />
                  ) : (
                    <Button
                      label={soldOut ? "Sold out" : "Add"}
                      accessibilityLabel={`Add ${item.name}`}
                      variant="secondary"
                      disabled={soldOut || !o.accepting_orders}
                      busy={pending === item.id}
                      onPress={() => void change(item, 1)}
                    />
                  )}
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
      {cartHere && (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: space.md,
            backgroundColor: t.surface,
            borderTopWidth: 1,
            borderTopColor: t.line,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={{ color: t.ink, fontWeight: "600" }}>
            {cartHere.item_count} items · {formatPaise(cartHere.subtotal_paise)}
          </Text>
          <Button label="Choose pickup time" onPress={() => router.push("/cart")} />
        </View>
      )}
    </View>
  );
}
