import { InboxList, ReviewView, RevisionView } from "@emend/contract";
import { queryOptions } from "@tanstack/react-query";
import { viewedState } from "../lib/viewed-state.ts";
import { get } from "./client.ts";

/** Inbox cache data includes the server clock's offset from this browser, in milliseconds. */
export type InboxData = InboxList & { clockOffset: number };

export const inboxQuery = () =>
  queryOptions({
    queryKey: ["inbox"],
    queryFn: async ({ signal }): Promise<InboxData> => {
      const list = await get("/api/v1/reviews", InboxList, signal);
      const receivedAt = Date.now();
      return { ...list, clockOffset: Date.parse(list.serverTime) - receivedAt };
    },
  });
export const reviewQuery = (id: string) =>
  queryOptions({
    queryKey: ["review", id],
    queryFn: ({ signal }) => get(`/api/v1/reviews/${encodeURIComponent(id)}`, ReviewView, signal),
  });
export const revisionQuery = (id: string, seq: number) =>
  queryOptions({
    queryKey: ["revision", id, seq],
    queryFn: ({ signal, client }) =>
      viewedState(client).fetch(id, seq, signal, () =>
        get(`/api/v1/reviews/${encodeURIComponent(id)}/revisions/${seq}`, RevisionView, signal),
      ),
    staleTime: Infinity,
  });
