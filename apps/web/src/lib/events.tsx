import type { ReviewEvent } from "@emend/contract";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { subscribeReviewEvents } from "./event-stream.ts";
import { InboxArrivalsProvider } from "./inbox-arrivals.tsx";
import { refreshQueries } from "./query-refresh.ts";
import { requestThemeSync } from "./theme.ts";

const PublishedRevisions = createContext<ReadonlyMap<string, number>>(new Map());
// These events change a review's state, update time or bin state, which another review's related list shows and orders by.
const relatedReviewEvents = new Set<ReviewEvent["type"]>([
  "publish",
  "send",
  "claimed",
  "unsnooze",
  "retire",
  "reopen",
  "bin",
  "restore",
  "delete",
]);

export function ReviewEventsProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const client = useQueryClient();
  const [published, setPublished] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    if (!enabled) {
      setPublished(new Map());
      return;
    }
    const receive = (event: ReviewEvent) => {
      if (event.type === "themes") {
        requestThemeSync();
        // A first fetch without data otherwise absorbs invalidation while it is pending.
        void client.cancelQueries({ queryKey: ["themes"] }).then(() => refreshQueries(client, [["themes"]]));
        return;
      }
      if (event.type === "groups" || event.type === "pins") {
        const reviewKey = event.reviewId ? ["review", event.reviewId] : ["review"];
        if (event.type === "pins" && client.isMutating({ mutationKey: ["pin-place"] })) {
          // The final queued move refetches; an earlier move's event must not erase its optimism.
          void client.invalidateQueries({ queryKey: ["inbox"], refetchType: "none" });
          refreshQueries(client, [reviewKey]);
        } else refreshQueries(client, [["inbox"], reviewKey]);
        return;
      }
      const { reviewId } = event;
      if (event.type === "publish")
        setPublished((previous) =>
          event.revision > (previous.get(reviewId) ?? 0) ? new Map(previous).set(reviewId, event.revision) : previous,
        );
      const reviewKey = relatedReviewEvents.has(event.type) ? ["review"] : ["review", reviewId];
      const keys = event.type === "viewed" ? [] : [["inbox"], reviewKey];
      if (["bin", "restore", "delete"].includes(event.type)) keys.push(["bin"]);
      if (["thread", "send", "claimed", "confirmed", "viewed", "retire"].includes(event.type))
        keys.push(["revision", reviewId]);
      refreshQueries(client, keys);
    };
    const stop = subscribeReviewEvents(receive, () => {
      requestThemeSync();
      refreshQueries(client, [], { opened: true });
    });
    return () => {
      stop();
    };
  }, [client, enabled]);
  return (
    <PublishedRevisions.Provider value={published}>
      <InboxArrivalsProvider enabled={enabled}>{children}</InboxArrivalsProvider>
    </PublishedRevisions.Provider>
  );
}

export function usePublishedRevision(reviewId: string) {
  return useContext(PublishedRevisions).get(reviewId) ?? 0;
}
