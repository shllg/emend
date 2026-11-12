import { BinView, InboxList, ReviewView, RevisionView, SettingsView } from "@emend/contract";
import { queryOptions } from "@tanstack/react-query";
import { viewedState } from "../lib/viewed-state.ts";
import { get } from "./client.ts";

/** Inbox cache data records both browser clocks when the response arrived, in milliseconds. */
export type InboxData = InboxList & { receivedAt: number; receivedMono: number };

// Use the larger elapsed time: wall time counts sleep, monotonic time survives a backward wall-clock change.
// A forward wall-clock change looks like sleep and can move a row early until the next refetch.
export function serverNow(data: Partial<InboxData> | undefined, wall = Date.now(), mono = performance.now()) {
  if (
    !data ||
    typeof data.receivedAt !== "number" ||
    typeof data.receivedMono !== "number" ||
    !Number.isFinite(data.receivedAt) ||
    !Number.isFinite(data.receivedMono)
  )
    return wall;
  const estimate = Date.parse(data.serverTime ?? "") + Math.max(wall - data.receivedAt, mono - data.receivedMono);
  return Number.isFinite(estimate) ? estimate : wall;
}

export const inboxQuery = () =>
  queryOptions({
    queryKey: ["inbox"],
    queryFn: async ({ signal }): Promise<InboxData> => {
      const list = await get("/api/v1/reviews", InboxList, signal);
      const receivedAt = Date.now();
      const receivedMono = performance.now();
      return { ...list, receivedAt, receivedMono };
    },
  });
export const reviewQuery = (id: string) =>
  queryOptions({
    queryKey: ["review", id],
    queryFn: ({ signal }) => get(`/api/v1/reviews/${encodeURIComponent(id)}`, ReviewView, signal),
  });
export const settingsQuery = () =>
  queryOptions({
    queryKey: ["settings"],
    queryFn: ({ signal }) => get("/api/v1/settings", SettingsView, signal),
  });
export const binQuery = () =>
  queryOptions({
    queryKey: ["bin"],
    queryFn: ({ signal }) => get("/api/v1/bin", BinView, signal),
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
