"use client";

import { OutletPicker, SignOutButton, StaffGate } from "@campuscart/staff-web";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/kitchen", label: "Kitchen" },
  { href: "/menu", label: "Menu & stock" },
  { href: "/refunds", label: "Refunds" },
  { href: "/specials", label: "Specials & polls" },
  { href: "/reviews", label: "Reviews" },
  { href: "/parties", label: "Party bookings" },
  { href: "/slots", label: "Slots & hours" },
  { href: "/staff", label: "Staff" },
  { href: "/settings", label: "Settings" },
];

function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Manager sections" className="-mx-1 flex gap-1 overflow-x-auto pb-1">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-primary-soft text-primary" : "text-muted hover:text-ink"}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Sign-in gate (managers and admins only), outlet picker and section navigation. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <StaffGate appName="CampusCart Manager" need="manager">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto grid max-w-6xl gap-3 px-4 pt-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-4">
              <p className="text-lg font-bold tracking-tight">CampusCart Manager</p>
              <div className="min-w-48">
                <OutletPicker />
              </div>
            </div>
            <SignOutButton />
          </div>
          <Nav />
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 pb-24 pt-6">
        {children}
      </main>
    </StaffGate>
  );
}
