import type { ReactNode } from "react";

export type Tone = "neutral" | "info" | "progress" | "success" | "danger" | "warning";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  info: "bg-info-soft text-info",
  progress: "bg-primary-soft text-primary",
  success: "bg-ok-soft text-ok",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warn-soft text-warn",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
