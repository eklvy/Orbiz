import { formatPaise } from "@campuscart/client";
import { Link, router } from "expo-router";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { OrderStatusBadge } from "@/components/status";
import { Button, Card, Empty, ErrorBox, Loading, Muted, makeStyles } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { useOrderHistory } from "@/lib/hooks";
import { space, useTheme } from "@/lib/theme";

export default function OrdersScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const { session, ready } = useAuth();
  const history = useOrderHistory();
  if (!ready) return <Loading label="Loading" />;
  if (!session) {
    return (
      <View style={[s.screen, s.content]}>
        <Empty title="Sign in to see your orders" />
        <Button label="Sign in" onPress={() => router.push("/login")} />
      </View>
    );
  }
  const orders = history.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.content}
      data={orders}
      keyExtractor={(o) => o.id}
      refreshControl={
        <RefreshControl
          refreshing={history.isRefetching}
          onRefresh={() => void history.refetch()}
        />
      }
      onEndReached={() =>
        history.hasNextPage && !history.isFetchingNextPage && void history.fetchNextPage()
      }
      ListEmptyComponent={
        history.isPending ? (
          <Loading label="Loading orders" />
        ) : history.isError ? (
          <ErrorBox error={history.error} onRetry={() => void history.refetch()} />
        ) : (
          <Empty title="No orders yet" message="Find something to eat on the Outlets tab." />
        )
      }
      ListFooterComponent={history.isFetchingNextPage ? <Loading label="Loading more" /> : null}
      renderItem={({ item }) => (
        <Link href={{ pathname: "/order/[id]", params: { id: item.id } }} asChild>
          <Pressable accessibilityRole="link">
            <Card>
              <View
                style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}
              >
                <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }}>
                  {item.token_label ? `${item.token_label} · ` : ""}
                  {item.outlet.name}
                </Text>
                <OrderStatusBadge status={item.status} />
              </View>
              <Muted>{item.items.map((i) => `${i.quantity}× ${i.item_name}`).join(", ")}</Muted>
              <Text style={{ color: t.ink, fontWeight: "600" }}>
                {formatPaise(item.total_paise)}
              </Text>
            </Card>
          </Pressable>
        </Link>
      )}
    />
  );
}
