"use client";

import { formatPaise, staffQueryKeys, type Schemas } from "@campuscart/client";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useManagerMenu } from "@/components/hooks";

function localDate(timeZone: string, addDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(
    new Date(Date.now() + addDays * 86_400_000),
  );
}

function SpecialForm({
  items,
  timeZone,
}: {
  items: Schemas["ManagerMenuItem"][];
  timeZone: string;
}) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  const [itemId, setItemId] = useState("");
  const [date, setDate] = useState(() => localDate(timeZone));
  const [discount, setDiscount] = useState("20");
  const [portions, setPortions] = useState("30");
  const [headline, setHeadline] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.saveSpecial(outlet.id, {
        menu_item_id: itemId,
        special_date: date,
        discount_percent: Number(discount),
        portions: Number(portions),
        ...(headline.trim() ? { headline: headline.trim() } : {}),
      }),
    onSuccess: (list) => queryClient.setQueryData(staffQueryKeys.specials(outlet.id), list),
  });
  return (
    <form
      aria-label="Set a special"
      className="grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (itemId) save.mutate();
      }}
    >
      <SelectField label="Dish" value={itemId} onChange={(e) => setItemId(e.target.value)}>
        <option value="">Choose…</option>
        {items
          .filter((i) => i.is_active)
          .map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({formatPaise(i.price_paise)})
            </option>
          ))}
      </SelectField>
      <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <Field
        label="Discount (%)"
        type="number"
        min={1}
        max={90}
        value={discount}
        onChange={(e) => setDiscount(e.target.value)}
      />
      <Field
        label="Portions"
        type="number"
        min={1}
        max={1000}
        value={portions}
        onChange={(e) => setPortions(e.target.value)}
      />
      <Field
        label="Headline (optional)"
        className="sm:col-span-2"
        maxLength={120}
        value={headline}
        onChange={(e) => setHeadline(e.target.value)}
      />
      <p className="text-xs text-muted sm:col-span-2">
        A new special for today notifies students who ordered here in the last 30 days.
      </p>
      <InlineError error={save.error} />
      <Button type="submit" busy={save.isPending} disabled={!itemId} className="justify-self-start">
        Save special
      </Button>
    </form>
  );
}

function PollForm({ items, timeZone }: { items: Schemas["ManagerMenuItem"][]; timeZone: string }) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("What should tomorrow's special be?");
  const [chosen, setChosen] = useState<string[]>([]);
  const [hours, setHours] = useState("6");
  const [discount, setDiscount] = useState("20");
  const [portions, setPortions] = useState("30");
  const create = useMutation({
    mutationFn: () =>
      api.createPoll(outlet.id, {
        question,
        menu_item_ids: chosen,
        closes_at: new Date(Date.now() + Number(hours) * 3_600_000).toISOString(),
        special_date: localDate(timeZone, 1),
        special_discount_percent: Number(discount),
        special_portions: Number(portions),
      }),
    onSuccess: () => {
      setChosen([]);
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.polls(outlet.id) });
    },
  });
  return (
    <form
      aria-label="Start a poll"
      className="grid gap-3 rounded-2xl border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen.length >= 2) create.mutate();
      }}
    >
      <Field
        label="Question"
        value={question}
        maxLength={200}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <fieldset className="grid gap-1 text-sm">
        <legend className="font-medium">Dishes (2–6)</legend>
        {items
          .filter((i) => i.is_active)
          .map((i) => (
            <label key={i.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={chosen.includes(i.id)}
                disabled={!chosen.includes(i.id) && chosen.length >= 6}
                onChange={(e) =>
                  setChosen((c) => (e.target.checked ? [...c, i.id] : c.filter((x) => x !== i.id)))
                }
              />
              {i.name}
            </label>
          ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Voting open for (hours)"
          type="number"
          min={1}
          max={72}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
        <Field
          label="Winner's discount (%)"
          type="number"
          min={1}
          max={90}
          value={discount}
          onChange={(e) => setDiscount(e.target.value)}
        />
        <Field
          label="Winner's portions"
          type="number"
          min={1}
          max={1000}
          value={portions}
          onChange={(e) => setPortions(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted">
        The winner becomes tomorrow&apos;s special. Votes guide you; you decide.
      </p>
      <InlineError error={create.error} />
      <Button
        type="submit"
        busy={create.isPending}
        disabled={chosen.length < 2}
        className="justify-self-start"
      >
        Start poll
      </Button>
    </form>
  );
}

function PollCard({ poll }: { poll: Schemas["Poll"] }) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: staffQueryKeys.polls(outlet.id) });
    void queryClient.invalidateQueries({ queryKey: staffQueryKeys.specials(outlet.id) });
  };
  const publish = useMutation({
    mutationFn: (optionId?: string) => api.publishPoll(poll.id, optionId),
    onSuccess: refresh,
  });
  const close = useMutation({ mutationFn: () => api.closePoll(poll.id), onSuccess: refresh });
  return (
    <li
      className="grid gap-2 rounded-xl border border-line bg-surface p-4"
      aria-label={poll.question}
      data-testid="manager-poll"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{poll.question}</p>
        <Badge
          tone={
            poll.status === "open" ? "info" : poll.status === "published" ? "success" : "neutral"
          }
        >
          {poll.status === "open"
            ? `${poll.total_votes} votes`
            : poll.status === "published"
              ? "Published"
              : "Closed"}
        </Badge>
      </div>
      <ul className="grid gap-1 text-sm">
        {poll.options.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-2">
            <span>
              {o.item_name} · {o.vote_count} ({o.percent}%)
              {poll.winner_option_id === o.id && " · winner"}
            </span>
            {poll.status !== "published" && (
              <Button
                size="sm"
                variant="secondary"
                busy={publish.isPending && publish.variables === o.id}
                onClick={() => publish.mutate(o.id)}
              >
                Publish this
              </Button>
            )}
          </li>
        ))}
      </ul>
      {poll.status !== "published" && (
        <div className="flex gap-2">
          <Button
            size="sm"
            busy={publish.isPending && publish.variables === undefined}
            onClick={() => publish.mutate(undefined)}
          >
            Publish the top dish
          </Button>
          {poll.status === "open" && (
            <Button size="sm" variant="ghost" busy={close.isPending} onClick={() => close.mutate()}>
              Close voting
            </Button>
          )}
        </div>
      )}
      <InlineError error={publish.error ?? close.error} />
    </li>
  );
}

export default function SpecialsPage() {
  const { outlet } = useCurrentOutlet();
  const { api } = useRuntime();
  const queryClient = useQueryClient();
  const menu = useManagerMenu();
  const specials = useQuery({
    queryKey: staffQueryKeys.specials(outlet.id),
    queryFn: () => api.specials(outlet.id),
  });
  const polls = useQuery({
    queryKey: staffQueryKeys.polls(outlet.id),
    queryFn: () => api.polls(outlet.id),
    refetchInterval: 15_000,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSpecial(id),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.specials(outlet.id) }),
  });
  if (menu.isPending) return <Loading label="Loading menu" />;
  if (menu.isError) return <ErrorState error={menu.error} onRetry={() => void menu.refetch()} />;
  return (
    <div className="grid gap-8">
      <h1 className="text-2xl font-bold tracking-tight">Specials &amp; polls</h1>
      <section aria-labelledby="specials-heading" className="grid gap-3">
        <h2 id="specials-heading" className="text-lg font-semibold">
          Daily specials
        </h2>
        <SpecialForm items={menu.data.items} timeZone={outlet.timezone} />
        <InlineError error={remove.error} />
        {specials.isPending ? (
          <Loading label="Loading specials" />
        ) : specials.isError ? (
          <ErrorState error={specials.error} onRetry={() => void specials.refetch()} />
        ) : specials.data.length === 0 ? (
          <EmptyState title="No specials planned" />
        ) : (
          <ul className="grid gap-2">
            {specials.data.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3"
                data-testid="manager-special"
              >
                <span>
                  <span className="font-semibold">{s.item_name}</span> · {s.special_date} ·{" "}
                  {s.discount_percent}% off → {formatPaise(s.special_price_paise)} ·{" "}
                  {s.portions_left}/{s.portions_total} portions left
                  {s.headline && <span className="block text-sm text-muted">“{s.headline}”</span>}
                </span>
                {s.portions_left === s.portions_total && (
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="polls-heading" className="grid gap-3">
        <h2 id="polls-heading" className="text-lg font-semibold">
          Student polls
        </h2>
        <PollForm items={menu.data.items} timeZone={outlet.timezone} />
        {polls.data && polls.data.length > 0 && (
          <ul className="grid gap-2">
            {polls.data.map((p) => (
              <PollCard key={p.id} poll={p} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
