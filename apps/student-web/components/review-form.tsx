"use client";

import { queryKeys, type Schemas } from "@campuscart/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { getApi } from "@/lib/api";
import { Button } from "./ui/button";
import { InlineError } from "./ui/states";

const DIMENSIONS = [
  ["taste", "Taste"],
  ["hygiene", "Hygiene"],
  ["speed", "Pickup speed"],
  ["value", "Value"],
] as const;
type Dimension = (typeof DIMENSIONS)[number][0];

function Stars({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="w-28 text-sm font-medium">{label}</legend>
      {[1, 2, 3, 4, 5].map((n) => (
        <label key={n} className="cursor-pointer">
          <input
            type="radio"
            name={label}
            value={n}
            checked={value === n}
            onChange={() => onChange(n)}
            className="peer sr-only"
          />
          <span
            className={`grid size-8 place-items-center rounded-full border text-sm peer-focus-visible:ring-2 peer-focus-visible:ring-primary ${n <= value ? "border-primary bg-primary text-primary-ink" : "border-line"}`}
          >
            {n}
            <span className="sr-only"> stars for {label}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Rate a collected order (7 days; +15 points). Shows the review and the kitchen's reply after. */
export function ReviewSection({ order }: { order: Schemas["OrderDetail"] }) {
  const queryClient = useQueryClient();
  const commentId = useId();
  const review = useQuery({
    queryKey: queryKeys.orderReview(order.id),
    queryFn: () => getApi().getOrderReview(order.id),
    enabled: order.status === "completed",
  });
  const [ratings, setRatings] = useState<Record<Dimension, number>>({
    taste: 0,
    hygiene: 0,
    speed: 0,
    value: 0,
  });
  const [comment, setComment] = useState("");
  const [openedAt] = useState(() => Date.now());
  const submit = useMutation({
    mutationFn: () =>
      getApi().submitReview(order.id, {
        ...ratings,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.orderReview(order.id), saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.loyalty });
    },
  });

  if (order.status !== "completed" || review.isPending) return null;
  if (review.data) {
    const r = review.data;
    return (
      <section
        aria-label="Your review"
        className="rounded-2xl border border-line bg-surface p-5 text-sm"
      >
        <p className="font-semibold">Your review</p>
        <p className="mt-1">
          Taste {r.taste} · Hygiene {r.hygiene} · Speed {r.speed} · Value {r.value}
        </p>
        {r.comment && <p className="mt-1 text-muted">“{r.comment}”</p>}
        {r.reply && (
          <p
            className="mt-2 rounded-lg bg-primary-soft px-3 py-2 text-primary"
            data-testid="review-reply"
          >
            <span className="font-semibold">Reply from {order.outlet.name}:</span> {r.reply}
          </p>
        )}
      </section>
    );
  }
  const tooOld =
    order.completed_at !== null &&
    openedAt - new Date(order.completed_at).getTime() > 7 * 86_400_000;
  if (tooOld) return null;
  const complete = Object.values(ratings).every((n) => n > 0);
  return (
    <form
      aria-label="Rate your order"
      className="grid gap-3 rounded-2xl border border-line bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete) submit.mutate();
      }}
    >
      <p className="font-semibold">How was it? Earn 15 points for a review.</p>
      {DIMENSIONS.map(([key, label]) => (
        <Stars
          key={key}
          label={label}
          value={ratings[key]}
          onChange={(n) => setRatings((r) => ({ ...r, [key]: n }))}
        />
      ))}
      <label htmlFor={commentId} className="text-sm font-medium">
        Comment (optional)
      </label>
      <textarea
        id={commentId}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={1000}
        rows={2}
        className="rounded-lg border border-line bg-surface px-3 py-2"
      />
      <p className="text-xs text-muted">Reviews are public but anonymous.</p>
      <InlineError error={submit.error} />
      <Button
        type="submit"
        busy={submit.isPending}
        disabled={!complete}
        className="justify-self-start"
      >
        Post review
      </Button>
    </form>
  );
}
