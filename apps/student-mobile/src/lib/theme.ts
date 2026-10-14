import { useColorScheme } from "react-native";

// Same semantic tokens as the website (apps/student-web/app/globals.css).
const light = {
  bg: "#f6f5f2",
  surface: "#ffffff",
  surface2: "#f1efea",
  ink: "#1b1a17",
  muted: "#57534e",
  line: "#e4e1da",
  primary: "#0f6b5c",
  primaryInk: "#ffffff",
  primarySoft: "#dff3ee",
  accent: "#c2410c",
  ok: "#166534",
  okSoft: "#dcfce7",
  warn: "#92400e",
  warnSoft: "#fef3c7",
  danger: "#b91c1c",
  dangerSoft: "#fee2e2",
  info: "#1e40af",
  infoSoft: "#dbeafe",
};
const dark: typeof light = {
  bg: "#12110f",
  surface: "#1c1b18",
  surface2: "#262420",
  ink: "#f3f1ec",
  muted: "#b5afa5",
  line: "#34312b",
  primary: "#5cc4ad",
  primaryInk: "#0b1f1a",
  primarySoft: "#173a33",
  accent: "#fb923c",
  ok: "#86efac",
  okSoft: "#14361f",
  warn: "#fcd34d",
  warnSoft: "#3a2c0b",
  danger: "#fca5a5",
  dangerSoft: "#3d1414",
  info: "#93c5fd",
  infoSoft: "#162a4a",
};

export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === "dark" ? dark : light);
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 8, md: 12, lg: 16 };
