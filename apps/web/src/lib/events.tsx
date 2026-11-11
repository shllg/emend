import type { ReviewEvent } from "@emend/contract";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { subscribeReviewEvents } from "./event-stream.ts";
import { InboxArrivalsProvider } from "./inbox-arrivals.tsx";
import { refreshQueries } from "./query-refresh.ts";

const PublishedRevisions = createContext<ReadonlyMap<string, number>>(new Map());

export function ReviewEventsProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const client = useQueryClient();
  const [published, setPublished] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    if (!enabled) {
      setPublished(new Map());
      return;
    }
    const receive = (event: ReviewEvent) => {
      const { reviewId } = event;
      if (event.type === "publish")
        setPublished((previous) =>
          event.revision > (previous.get(reviewId) ?? 0) ? new Map(previous).set(reviewId, event.revision) : previous,
        );
      const keys = event.type === "viewed" ? [] : [["inbox"], ["review", reviewId]];
      if (["thread", "send", "claimed", "confirmed", "viewed", "retire"].includes(event.type))
        keys.push(["revision", reviewId]);
      refreshQueries(client, keys);
    };
    const stop = subscribeReviewEvents(receive, () => {
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
