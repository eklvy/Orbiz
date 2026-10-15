"use client";

import { StaffProviders } from "@campuscart/staff-web";
import type { ReactNode } from "react";
import { createRuntime } from "@/lib/runtime";

export function Providers({ children }: { children: ReactNode }) {
  return <StaffProviders runtime={createRuntime}>{children}</StaffProviders>;
}
