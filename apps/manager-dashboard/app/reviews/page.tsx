"use client";

import { staffQueryKeys, type Schemas } from "@campuscart/client";
import {
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  Loading,
  Stat,
  useCurrentOutlet,
  useRuntime,
} from "@campuscart/staff-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

function ReviewItem({ review }: { review: Schemas["Review"] }) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  const id = useId();
  const [text, setText] = useState("");
  const reply = useMutation({
    mutationFn: () => api.replyToReview(review.id, text.trim()),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.reviews(outlet.id) }),
  });
  const overall = (review.taste + review.hygiene + review.speed + review.value) / 4;
  return (
    <li
      className="grid gap-2 rounded-xl border border-line bg-surface p-4"
      data-testid="manager-review"
    >
      <p className="text-sm">
        <span className="font-semibold">{overall.toFixed(1)} / 5</span> · Taste {review.taste} ·
        Hygiene {review.hygiene} · Speed {review.speed} · Value {review.value}
      </p>
      {review.comment && <p>“{review.comment}”</p>}
      <p className="text-xs text-muted">
        {new Date(review.created_at).toLocaleString("en-IN", { timeZone: outlet.timezone })}
      </p>
      {review.reply ? (
        <p className="rounded-lg bg-primary-soft px-3 py-2 text-sm text-primary">
          Your reply: {review.reply}
        </p>
      ) : (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) reply.mutate();
          }}
        >
          <label htmlFor={id} className="text-sm font-medium">
            Reply as {outlet.name}
          </label>
          <textarea
            id={id}
            value={text}
            maxLength={1000}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            className="rounded-lg border border-line bg-surface px-3 py-2"
          />
          <InlineError error={reply.error} />
          <Button
            type="submit"
            size="sm"
            busy={reply.isPending}
            disabled={!text.trim()}
            className="justify-self-start"
          >
            Send reply
          </Button>
        </form>
      )}
    </li>
  );
}

export default function ReviewsPage() {
  const { outlet } = useCurrentOutlet();
  const { api } = useRuntime();
  const [needsReply, setNeedsReply] = useState(false);
  const reviews = useQuery({
    queryKey: [...staffQueryKeys.reviews(outlet.id), needsReply],
    queryFn: () => api.reviews(outlet.id, needsReply),
    refetchInterval: 30_000,
  });
  const ratings = useQuery({ queryKey: ["ratings"], queryFn: () => api.ratings() });
  const mine = ratings.data?.find((r) => r.outlet_id === outlet.id);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Reviews</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Overall"
          value={mine ? mine.overall.toFixed(1) : "—"}
          hint={mine ? `${mine.review_count} reviews` : "No reviews yet"}
        />
        <Stat
          label="Taste / Hygiene"
          value={mine ? `${mine.taste.toFixed(1)} / ${mine.hygiene.toFixed(1)}` : "—"}
        />
        <Stat
          label="Speed / Value"
          value={mine ? `${mine.speed.toFixed(1)} / ${mine.value.toFixed(1)}` : "—"}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={needsReply}
          onChange={(e) => setNeedsReply(e.target.checked)}
        />
        Only reviews without a reply
      </label>
      {reviews.isPending ? (
        <Loading label="Loading reviews" />
      ) : reviews.isError ? (
        <ErrorState error={reviews.error} onRetry={() => void reviews.refetch()} />
      ) : reviews.data.length === 0 ? (
        <EmptyState title={needsReply ? "Every review has a reply" : "No reviews yet"} />
      ) : (
        <ul className="grid gap-2">
          {reviews.data.map((r) => (
            <ReviewItem key={r.id} review={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
