import { Alert, Platform } from "react-native";

/** Yes/no prompt that works on iOS, Android and the web build (RN Web has no Alert buttons). */
export function confirm(title: string, message: string, confirmLabel = "OK"): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Not now", style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
    ]),
  );
}
