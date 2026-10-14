import type { Schemas } from "@campuscart/client";
import { Link } from "expo-router";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { LiveIndicator } from "@/components/status";
import { Badge, Card, Empty, ErrorBox, Loading, Muted, Title, makeStyles } from "@/components/ui";
import { useOutlets } from "@/lib/hooks";
import { space, useTheme } from "@/lib/theme";

function OutletStatus({ outlet }: { outlet: Schemas["Outlet"] }) {
  if (outlet.accepting_orders) return <Badge tone="success" label="Open" />;
  return (
    <Badge
      tone={outlet.status === "on_break" ? "warning" : "neutral"}
      label={outlet.status === "on_break" ? "On a break" : "Closed"}
    />
  );
}

const CROWD = {
  low: ["success", "Quiet"],
  medium: ["warning", "Busy"],
  high: ["danger", "Very busy"],
} as const;

export default function OutletsScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const outlets = useOutlets();
  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.content}
      data={outlets.data ?? []}
      keyExtractor={(o) => o.id}
      refreshControl={
        <RefreshControl
          refreshing={outlets.isRefetching}
          onRefresh={() => void outlets.refetch()}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: space.sm, marginBottom: space.sm }}>
          <Title>Skip the queue.</Title>
          <Muted>
            Order before you leave class, pick a pickup time, and collect with your token.
          </Muted>
          <LiveIndicator status={outlets.live} />
        </View>
      }
      ListEmptyComponent={
        outlets.isPending ? (
          <Loading label="Loading outlets" />
        ) : outlets.isError ? (
          <ErrorBox error={outlets.error} onRetry={() => void outlets.refetch()} />
        ) : (
          <Empty title="No outlets are listed yet" />
        )
      }
      renderItem={({ item }) => {
        const [tone, crowd] = CROWD[item.queue.crowd_level];
        return (
          <Link href={{ pathname: "/outlet/[slug]", params: { slug: item.slug } }} asChild>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`${item.name}, ${item.accepting_orders ? "open" : "not taking orders"}`}
            >
              <Card>
                <View
                  style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.ink, fontSize: 18, fontWeight: "700" }}>
                      {item.name}
                    </Text>
                    {item.location && <Muted>{item.location}</Muted>}
                  </View>
                  <OutletStatus outlet={item} />
                </View>
                {!item.accepting_orders && item.status_reason && (
                  <Muted>“{item.status_reason}”</Muted>
                )}
                <View style={{ flexDirection: "row", gap: space.lg, alignItems: "center" }}>
                  <Text style={{ color: t.ink, fontWeight: "700" }}>
                    ~{item.queue.estimated_wait_minutes} min wait
                  </Text>
                  <Muted>{item.queue.active_orders} in queue</Muted>
                  <Badge tone={tone} label={crowd} />
                </View>
              </Card>
            </Pressable>
          </Link>
        );
      }}
      ListFooterComponent={
        <Muted>Wait times are estimated from current orders, not from cameras or sensors.</Muted>
      }
    />
  );
}
