"use client";

import { queryKeys } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useMyVotes, usePolls } from "@/lib/hooks";
import { Badge } from "./ui/badge";
import { InlineError } from "./ui/states";

/** "Vote for tomorrow's special": one vote per student, live percentages; the manager decides. */
export function PollsSection({ outletId, slug }: { outletId: string; slug: string }) {
  const router = useRouter();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const polls = usePolls(outletId);
  const mine = useMyVotes(outletId);
  // Read once per visit for display; the server refuses late votes regardless.
  const [openedAt] = useState(() => Date.now());
  const vote = useMutation({
    mutationFn: (v: { pollId: string; optionId: string }) => getApi().vote(v.pollId, v.optionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.polls(outletId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.myVotes(outletId) });
    },
  });
  const visible = (polls.data ?? []).filter((p) => p.status !== "closed");
  if (visible.length === 0) return null;
  const votedFor = new Map((mine.data ?? []).map((v) => [v.poll_id, v.option_id]));

  return (
    <section aria-labelledby="polls-heading" className="grid gap-3">
      <h2 id="polls-heading" className="text-lg font-semibold">
        Vote for a special
      </h2>
      <InlineError error={vote.error} />
      {visible.map((poll) => {
        const myVote = votedFor.get(poll.id);
        const open = poll.status === "open" && new Date(poll.closes_at).getTime() > openedAt;
        return (
          <article
            key={poll.id}
            className="grid gap-3 rounded-xl border border-line bg-surface p-4"
            aria-label={poll.question}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">{poll.question}</p>
              {poll.status === "published" ? (
                <Badge tone="success">Decided</Badge>
              ) : (
                <span className="text-xs text-muted">
                  {poll.total_votes} vote{poll.total_votes === 1 ? "" : "s"} ·{" "}
                  {poll.special_discount_percent}% off for the chosen dish
                </span>
              )}
            </div>
            <ul className="grid gap-2">
              {poll.options.map((option) => {
                const won = poll.winner_option_id === option.id;
                const canVote = open && !myVote;
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      disabled={!canVote || vote.isPending}
                      onClick={() =>
                        session
                          ? vote.mutate({ pollId: poll.id, optionId: option.id })
                          : router.push(`/login?next=/outlets/${slug}`)
                      }
                      aria-label={`${option.item_name}: ${option.percent}%${myVote === option.id ? ", your vote" : ""}${canVote ? ". Vote" : ""}`}
                      className="relative w-full overflow-hidden rounded-lg border border-line px-3 py-2 text-left text-sm enabled:hover:border-primary disabled:cursor-default"
                    >
                      <span
                        className="absolute inset-y-0 left-0 bg-primary-soft"
                        style={{ width: `${option.percent}%` }}
                        aria-hidden
                      />
                      <span className="relative flex justify-between gap-2">
                        <span className="font-medium">
                          {option.item_name}
                          {myVote === option.id && " · your vote"}
                          {won && " · chosen"}
                        </span>
                        <span>{option.percent}%</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
    </section>
  );
}
