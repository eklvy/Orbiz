"use client";

import {
  formatPaise,
  paiseToRupeeInput,
  parseRupeesToPaise,
  staffQueryKeys,
  type ManagerMenuItem,
  type Schemas,
} from "@campuscart/client";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  Loading,
  SelectField,
  useCurrentOutlet,
  useRuntime,
} from "@campuscart/staff-web";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useManagerMenu } from "@/components/hooks";

type Category = Schemas["ManagerCategory"];
type Availability = Schemas["AvailabilityUpdate"]["manual_status"];

const STOCK_TONE = { available: "success", low: "warning", sold_out: "danger" } as const;
const STOCK_LABEL = { available: "Available", low: "Low", sold_out: "Sold out" } as const;

function useInvalidateMenu() {
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: staffQueryKeys.menu(outlet.id) });
}

function optionalInt(value: string): number | null {
  return value.trim() === "" ? null : Number.parseInt(value, 10);
}

function ItemForm({
  item,
  categories,
  onDone,
}: {
  item: ManagerMenuItem | null;
  categories: Category[];
  onDone: () => void;
}) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const invalidate = useInvalidateMenu();
  const [name, setName] = useState(item?.name ?? "");
  const [price, setPrice] = useState(item ? paiseToRupeeInput(item.price_paise) : "");
  const [categoryId, setCategoryId] = useState(item?.category_id ?? "");
  const [diet, setDiet] = useState<string>(item?.diet ?? "");
  const [prep, setPrep] = useState(String(item?.prep_minutes ?? 5));
  const [calories, setCalories] = useState(item?.calories_kcal?.toString() ?? "");
  const [protein, setProtein] = useState(item?.protein_g?.toString() ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [packaged, setPackaged] = useState(item?.is_packaged ?? false);
  const [active, setActive] = useState(item?.is_active ?? true);
  const [priceError, setPriceError] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (body: Schemas["MenuItemInput"]) =>
      item ? api.updateItem(item.id, body) : api.createItem(outlet.id, body),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const pricePaise = parseRupeesToPaise(price);
    if (pricePaise === null) {
      setPriceError("Enter a price in rupees, e.g. 70 or 70.50");
      return;
    }
    setPriceError(undefined);
    save.mutate({
      name: name.trim(),
      price_paise: pricePaise,
      category_id: categoryId || null,
      diet: diet ? (diet as NonNullable<Schemas["MenuItemInput"]["diet"]>) : null,
      prep_minutes: Number.parseInt(prep, 10) || 0,
      calories_kcal: optionalInt(calories),
      protein_g: optionalInt(protein),
      description: description.trim() || null,
      is_packaged: packaged,
      is_active: active,
      sort_order: item?.sort_order ?? 0,
    });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={item ? `Edit ${item.name}` : "New menu item"}
      className="grid gap-3 rounded-xl border-2 border-primary/40 bg-surface p-4 sm:grid-cols-2"
    >
      <Field
        label="Name"
        required
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Field
        label="Price (₹)"
        inputMode="decimal"
        required
        value={price}
        error={priceError}
        onChange={(e) => setPrice(e.target.value)}
      />
      <SelectField
        label="Category"
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
      >
        <option value="">No category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <SelectField label="Diet" value={diet} onChange={(e) => setDiet(e.target.value)}>
        <option value="">Not specified</option>
        <option value="veg">Veg</option>
        <option value="egg">Egg</option>
        <option value="non_veg">Non-veg</option>
      </SelectField>
      <Field
        label="Prep time (minutes)"
        type="number"
        min={0}
        max={180}
        value={prep}
        onChange={(e) => setPrep(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Calories (kcal)"
          type="number"
          min={0}
          max={5000}
          value={calories}
          onChange={(e) => setCalories(e.target.value)}
        />
        <Field
          label="Protein (g)"
          type="number"
          min={0}
          max={500}
          value={protein}
          onChange={(e) => setProtein(e.target.value)}
        />
      </div>
      <Field
        label="Description (optional)"
        className="sm:col-span-2"
        maxLength={500}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          checked={packaged}
          onChange={(e) => setPackaged(e.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          <span className="font-medium">Packaged item</span>
          <span className="block text-muted">
            Sealed and shelf-stable (bottled drinks, chips). If an order isn&apos;t collected, it
            goes back into stock instead of being sold as a discounted deal.
          </span>
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="size-4 accent-primary"
        />
        <span className="font-medium">On the menu</span>
        <span className="text-muted">(untick to archive; order history keeps it)</span>
      </label>
      <InlineError error={save.error} />
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" busy={save.isPending}>
          {item ? "Save changes" : "Add item"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function StockControls({ item }: { item: ManagerMenuItem }) {
  const { api } = useRuntime();
  const invalidate = useInvalidateMenu();
  const [restock, setRestock] = useState("");
  const [trackQty, setTrackQty] = useState("");
  const availability = useMutation({
    mutationFn: (status: Availability) => api.setAvailability(item.id, status),
    onSuccess: invalidate,
  });
  const adjust = useMutation({
    mutationFn: (delta: number) => api.adjustStock(item.id, { delta, reason: "restock" }),
    onSuccess: () => {
      setRestock("");
      invalidate();
    },
  });
  const tracking = useMutation({
    mutationFn: (body: Schemas["StockTracking"]) => api.setStockTracking(item.id, body),
    onSuccess: () => {
      setTrackQty("");
      invalidate();
    },
  });
  return (
    <div className="grid gap-2">
      <div
        role="group"
        aria-label={`Availability of ${item.name}`}
        className="flex flex-wrap gap-1"
      >
        {(["available", "low", "sold_out"] as const).map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={item.manual_status === status}
            disabled={availability.isPending}
            onClick={() => availability.mutate(status)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${item.manual_status === status ? "border-primary bg-primary-soft text-primary" : "border-line"}`}
          >
            {STOCK_LABEL[status]}
          </button>
        ))}
      </div>
      {item.track_quantity ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const delta = Number.parseInt(restock, 10);
            if (delta > 0) adjust.mutate(delta);
          }}
        >
          <Field
            label={`Restock ${item.name}`}
            type="number"
            min={1}
            max={100000}
            value={restock}
            onChange={(e) => setRestock(e.target.value)}
            className="w-32"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            busy={adjust.isPending}
            className="h-11"
          >
            Add stock
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-11"
            onClick={() => tracking.mutate({ track_quantity: false })}
          >
            Stop counting
          </Button>
        </form>
      ) : (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const quantity = Number.parseInt(trackQty, 10);
            if (quantity >= 0) tracking.mutate({ track_quantity: true, quantity });
          }}
        >
          <Field
            label={`Count stock of ${item.name}`}
            type="number"
            min={0}
            max={100000}
            placeholder="Quantity now"
            value={trackQty}
            onChange={(e) => setTrackQty(e.target.value)}
            className="w-36"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            busy={tracking.isPending}
            className="h-11"
          >
            Start counting
          </Button>
        </form>
      )}
      <InlineError error={availability.error ?? adjust.error ?? tracking.error} />
    </div>
  );
}

function ItemRow({ item, categories }: { item: ManagerMenuItem; categories: Category[] }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return <ItemForm item={item} categories={categories} onDone={() => setEditing(false)} />;
  return (
    <li
      className={`grid gap-3 rounded-xl border border-line bg-surface p-4 md:grid-cols-[1fr_auto] ${item.is_active ? "" : "border-dashed bg-surface-2"}`}
      aria-label={item.name}
      data-testid="menu-item"
    >
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{item.name}</p>
          <Badge tone={STOCK_TONE[item.stock_status]}>{STOCK_LABEL[item.stock_status]}</Badge>
          {item.is_packaged && <Badge tone="info">Packaged</Badge>}
          {!item.is_active && <Badge>Archived</Badge>}
        </div>
        <p className="text-sm text-muted">
          {formatPaise(item.price_paise)} · {item.prep_minutes} min prep
          {item.track_quantity &&
            ` · ${item.quantity_available ?? 0} in stock (low at ${item.low_stock_threshold ?? 0})`}
        </p>
        <p className="text-sm" data-testid="today-count">
          Today: {item.today_quantity} ordered in {item.today_orders} paid order
          {item.today_orders === 1 ? "" : "s"}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => setEditing(true)}
        >
          Edit details
        </Button>
      </div>
      {item.is_active && <StockControls item={item} />}
    </li>
  );
}

function Categories({ categories }: { categories: Category[] }) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const invalidate = useInvalidateMenu();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.createCategory(outlet.id, {
        name: name.trim(),
        sort_order: categories.length + 1,
        is_active: true,
      }),
    onSuccess: () => {
      setName("");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCategory(id),
    onSuccess: invalidate,
  });
  return (
    <section aria-labelledby="categories-heading" className="grid gap-3">
      <h2 id="categories-heading" className="text-lg font-semibold">
        Categories
      </h2>
      <ul className="flex flex-wrap gap-2">
        {categories.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-1 rounded-full border border-line bg-surface py-1 pl-3 pr-1 text-sm"
          >
            {c.name}
            <button
              type="button"
              aria-label={`Delete category ${c.name}`}
              onClick={() =>
                window.confirm(`Delete “${c.name}”? Its items stay, uncategorised.`) &&
                remove.mutate(c.id)
              }
              className="grid size-6 place-items-center rounded-full text-muted hover:bg-danger-soft hover:text-danger"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Field
          label="New category"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-56"
        />
        <Button type="submit" variant="secondary" busy={create.isPending} className="h-11">
          Add category
        </Button>
      </form>
      <InlineError error={create.error ?? remove.error} />
    </section>
  );
}

export default function MenuPage() {
  const menu = useManagerMenu();
  const [adding, setAdding] = useState(false);
  if (menu.isPending) return <Loading label="Loading menu" />;
  if (menu.isError) return <ErrorState error={menu.error} onRetry={() => void menu.refetch()} />;
  const { items, categories } = menu.data;
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const groups = [
    ...categories.map((c) => ({
      key: c.id,
      name: c.name,
      items: items.filter((i) => i.category_id === c.id),
    })),
    {
      key: "none",
      name: "No category",
      items: items.filter((i) => !i.category_id || !names.has(i.category_id)),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Menu &amp; stock</h1>
          <p className="text-sm text-muted">Changes reach the student app and website instantly.</p>
        </div>
        {!adding && <Button onClick={() => setAdding(true)}>Add item</Button>}
      </div>
      {adding && <ItemForm item={null} categories={categories} onDone={() => setAdding(false)} />}
      {items.length === 0 ? (
        <EmptyState title="No menu items yet">
          Add your first item to start taking orders.
        </EmptyState>
      ) : (
        groups.map((group) => (
          <section key={group.key} aria-labelledby={`group-${group.key}`} className="grid gap-3">
            <h2 id={`group-${group.key}`} className="text-lg font-semibold">
              {group.name}
            </h2>
            <ul className="grid gap-3">
              {group.items.map((item) => (
                <ItemRow key={item.id} item={item} categories={categories} />
              ))}
            </ul>
          </section>
        ))
      )}
      <Categories categories={categories} />
    </div>
  );
}
