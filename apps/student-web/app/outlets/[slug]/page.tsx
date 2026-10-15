"use client";

import {
  CampusCartApiError,
  formatPaise,
  type MenuFilters,
  type Schemas,
} from "@campuscart/client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DealsSection } from "@/components/deals-section";
import { ItemDialog } from "@/components/item-dialog";
import { MenuItemCard } from "@/components/menu-item-card";
import { OutletStatus } from "@/components/outlet-card";
import { EmptyState, ErrorState, InlineError, LoadingList, Skeleton } from "@/components/ui/states";
import { useAuth } from "@/lib/auth";
import { useCart, useMenu, useOutlet, useSetCartItem } from "@/lib/hooks";

const DIETS: { value: MenuFilters["diet"] | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "veg", label: "Veg" },
  { value: "egg", label: "Egg" },
  { value: "non_veg", label: "Non-veg" },
];
const PRICES = [undefined, 5000, 10000, 15000];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export default function OutletPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const outlet = useOutlet(slug);
  const [search, setSearch] = useState("");
  const [diet, setDiet] = useState<MenuFilters["diet"]>();
  const [maxPrice, setMaxPrice] = useState<number>();
  const [availableOnly, setAvailableOnly] = useState(false);
  const debouncedSearch = useDebounced(search.trim(), 250);
  const filters = useMemo<MenuFilters>(
    () => ({
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(diet ? { diet } : {}),
      ...(maxPrice ? { maxPricePaise: maxPrice } : {}),
      ...(availableOnly ? { availableOnly } : {}),
    }),
    [debouncedSearch, diet, maxPrice, availableOnly],
  );
  const menu = useMenu(outlet.data?.id, filters);
  const cart = useCart();
  const setItem = useSetCartItem();
  const [pendingItem, setPendingItem] = useState<string | null>(null);
  const [detail, setDetail] = useState<Schemas["MenuItem"] | null>(null);

  const quantities = new Map(
    cart.data?.outlet_id === outlet.data?.id
      ? (cart.data?.items ?? []).map((i) => [i.menu_item_id, i.quantity])
      : [],
  );

  async function change(item: Schemas["MenuItem"], quantity: number) {
    if (!session) {
      router.push(`/login?next=/outlets/${slug}`);
      return;
    }
    setPendingItem(item.id);
    try {
      await setItem.mutateAsync({ menuItemId: item.id, quantity });
    } catch (error) {
      if (
        error instanceof CampusCartApiError &&
        error.reason === "cart_outlet_mismatch" &&
        window.confirm("Your cart has items from another outlet. Start a new cart here instead?")
      ) {
        await setItem.mutateAsync({ menuItemId: item.id, quantity, replaceCart: true });
      }
    } finally {
      setPendingItem(null);
    }
  }

  if (outlet.isPending) return <Skeleton className="h-40" />;
  if (outlet.isError)
    return <ErrorState error={outlet.error} onRetry={() => void outlet.refetch()} />;

  const o = outlet.data;
  const items = menu.data
    ? [...menu.data.categories.flatMap((c) => c.items), ...menu.data.uncategorized]
    : [];
  const cartHere =
    cart.data && cart.data.outlet_id === o.id && cart.data.item_count > 0 ? cart.data : null;

  return (
    <div className="grid gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/" className="hover:text-ink">
          Outlets
        </Link>{" "}
        / <span aria-current="page">{o.name}</span>
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{o.name}</h1>
          <p className="text-muted">
            {o.location ?? ""} · ~{o.queue.estimated_wait_minutes} min wait ·{" "}
            {o.queue.active_orders} in queue
          </p>
        </div>
        <OutletStatus outlet={o} />
      </header>

      {!o.accepting_orders && (
        <p role="status" className="rounded-xl bg-warn-soft px-4 py-3 text-warn">
          {o.status === "on_break" ? "On a break" : "Closed"} — not taking orders right now.
          {o.status_reason && <span className="block text-sm">“{o.status_reason}”</span>}
        </p>
      )}

      <DealsSection outletId={o.id} slug={slug} timeZone={o.timezone} />

      <section
        aria-label="Filters"
        className="grid gap-3 rounded-xl border border-line bg-surface p-4"
      >
        <label className="grid gap-1 text-sm font-medium">
          Search the menu
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. sandwich"
            maxLength={60}
            className="h-11 rounded-lg border border-line bg-surface px-3 font-normal"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Diet:</span>
          {DIETS.map((d) => (
            <button
              key={d.label}
              type="button"
              aria-pressed={diet === d.value}
              onClick={() => setDiet(d.value)}
              className={`rounded-full border px-3 py-1 ${diet === d.value ? "border-primary bg-primary-soft text-primary" : "border-line"}`}
            >
              {d.label}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2">
            Max price
            <select
              value={maxPrice ?? ""}
              onChange={(e) => setMaxPrice(e.target.value ? Number(e.target.value) : undefined)}
              className="h-9 rounded-lg border border-line bg-surface px-2"
            >
              {PRICES.map((p) => (
                <option key={p ?? "any"} value={p ?? ""}>
                  {p ? formatPaise(p) : "Any"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={availableOnly}
              onChange={(e) => setAvailableOnly(e.target.checked)}
              className="size-4 accent-primary"
            />
            Available only
          </label>
        </div>
      </section>

      <InlineError error={setItem.error} />

      {menu.isPending ? (
        <LoadingList label="Loading menu" />
      ) : menu.isError ? (
        <ErrorState error={menu.error} onRetry={() => void menu.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={
            Object.keys(filters).length
              ? "Nothing matches these filters"
              : "No items on the menu yet"
          }
        />
      ) : (
        <div className="grid gap-8">
          {[
            ...menu.data.categories.map((c) => ({ key: c.id, name: c.name, items: c.items })),
            {
              key: "other",
              name: menu.data.categories.length ? "More" : "Menu",
              items: menu.data.uncategorized,
            },
          ]
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <section key={group.key} aria-labelledby={`cat-${group.key}`} className="grid gap-3">
                <h2 id={`cat-${group.key}`} className="text-lg font-semibold">
                  {group.name}
                </h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {group.items.map((item) => (
                    <MenuItemCard
                      key={item.id}
                      item={item}
                      quantity={quantities.get(item.id) ?? 0}
                      canOrder={o.accepting_orders}
                      busy={pendingItem === item.id}
                      onChange={(q) => void change(item, q)}
                      onOpen={() => setDetail(item)}
                    />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}

      {cartHere && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 p-3 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold">{cartHere.item_count} items</span> ·{" "}
              {formatPaise(cartHere.subtotal_paise)}
            </p>
            <Link
              href="/cart"
              className="inline-flex h-11 items-center rounded-lg bg-primary px-5 font-medium text-primary-ink hover:bg-primary-hover"
            >
              Choose pickup time
            </Link>
          </div>
        </div>
      )}
      <ItemDialog item={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
