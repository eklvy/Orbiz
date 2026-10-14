"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/hooks";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg px-2 py-2 text-sm font-medium sm:px-3 ${active ? "bg-primary-soft text-primary" : "text-muted hover:text-ink"}`}
    >
      {children}
    </Link>
  );
}

export function Header() {
  const { session, ready } = useAuth();
  const cart = useCart();
  const count = cart.data?.item_count ?? 0;
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-1 px-4 sm:gap-2">
        <Link
          href="/"
          className="mr-auto flex shrink-0 items-center gap-2 font-bold tracking-tight"
          aria-label="CampusCart home"
        >
          <span
            className="grid size-8 place-items-center rounded-lg bg-primary text-primary-ink"
            aria-hidden
          >
            C
          </span>
          <span className="hidden sm:inline">CampusCart</span>
        </Link>
        <nav aria-label="Main" className="flex min-w-0 items-center gap-0.5 sm:gap-1">
          <NavLink href="/">Outlets</NavLink>
          {ready && session && <NavLink href="/orders">Orders</NavLink>}
          {ready && session && (
            <NavLink href="/cart">
              Cart
              {count > 0 && (
                <span
                  className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-xs font-bold text-white"
                  aria-label={`${count} items`}
                >
                  {count}
                </span>
              )}
            </NavLink>
          )}
          {ready &&
            (session ? (
              <NavLink href="/profile">Profile</NavLink>
            ) : (
              <NavLink href="/login">Sign in</NavLink>
            ))}
        </nav>
      </div>
    </header>
  );
}
