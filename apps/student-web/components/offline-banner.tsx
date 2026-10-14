"use client";

import { useOnline } from "@/lib/use-online";

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="bg-warn-soft px-4 py-2 text-center text-sm font-medium text-warn">
      You&apos;re offline. Showing the last information we had; changes will need a connection.
    </div>
  );
}
