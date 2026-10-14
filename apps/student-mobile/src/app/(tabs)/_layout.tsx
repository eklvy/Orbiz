import { Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/hooks";
import { useTheme } from "@/lib/theme";

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  const t = useTheme();
  const { session } = useAuth();
  const count = useCart().data?.item_count ?? 0;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.ink,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line },
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.muted,
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Outlets", tabBarIcon: icon("◎") }} />
      <Tabs.Screen name="orders" options={{ title: "Orders", tabBarIcon: icon("☰") }} />
      <Tabs.Screen
        name="cart"
        options={{
          title: "Cart",
          tabBarIcon: icon("◻"),
          ...(session && count > 0
            ? { tabBarBadge: count, tabBarBadgeStyle: { backgroundColor: t.accent } }
            : {}),
        }}
      />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: icon("◉") }} />
    </Tabs>
  );
}
