import { queryKeys } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Button, Card, Empty, ErrorBox, Loading, makeStyles, Muted } from "@/components/ui";
import { api } from "@/lib/api";
import { useNotifications } from "@/lib/hooks";
import { space, useTheme } from "@/lib/theme";

export default function NotificationsScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  const markAll = useMutation({
    mutationFn: () => api.markNotificationsRead(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
  });
  if (notifications.isPending) return <Loading label="Loading notifications" />;
  if (notifications.isError)
    return <ErrorBox error={notifications.error} onRetry={() => void notifications.refetch()} />;
  const n = notifications.data;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: "Notifications" }} />
      {n.unread_count > 0 && (
        <Button
          label={`Mark all as read (${n.unread_count})`}
          variant="secondary"
          busy={markAll.isPending}
          onPress={() => markAll.mutate()}
        />
      )}
      {n.items.length === 0 ? (
        <Empty title="Nothing yet" message="Order updates, refunds and points will show up here." />
      ) : (
        n.items.map((item) => {
          const orderId = typeof item.data.order_id === "string" ? item.data.order_id : null;
          return (
            <Pressable
              key={item.id}
              accessibilityRole={orderId ? "link" : "text"}
              onPress={() => orderId && router.push(`/order/${orderId}`)}
            >
              <Card style={{ gap: 2, borderColor: item.read_at ? t.line : t.info }}>
                <View
                  style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}
                >
                  <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }}>{item.title}</Text>
                  {!item.read_at && <Text style={{ color: t.info, fontSize: 12 }}>New</Text>}
                </View>
                <Muted>{item.body}</Muted>
              </Card>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}
