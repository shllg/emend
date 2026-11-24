import type { RevisionView, ViewedRequest } from "@recense/contract";
import type { QueryClient } from "@tanstack/react-query";

export type ViewedChange = {
  id: number;
  reviewId: string;
  body: ViewedRequest;
  status: "pending" | "success" | "error";
  settled?: number;
  error?: Error;
  failedPaths?: string[];
};

const stores = new WeakMap<QueryClient, ReturnType<typeof createStore>>();
function createStore(client: QueryClient) {
  let clock = 0;
  let changes: ViewedChange[] = [];
  const listeners = new Set<() => void>();
  const completed = new Map<string, number>();
  const publish = (next: ViewedChange[]) => {
    changes = next;
    for (const listener of listeners) listener();
  };
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
    const [kind, reviewId, seq] = event.query.queryKey;
    if (kind !== "revision") return;
    const started = completed.get(`${reviewId}:${seq}`);
    if (started === undefined) return;
    completed.delete(`${reviewId}:${seq}`);
    const next = changes.filter(
      (change) =>
        !(
          change.reviewId === reviewId &&
          change.body.revision === seq &&
          change.status === "success" &&
          change.settled !== undefined &&
          started > change.settled
        ),
    );
    if (next.length !== changes.length) publish(next);
  });
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => changes,
    start(reviewId: string, body: ViewedRequest) {
      const id = ++clock;
      publish([...changes, { id, reviewId, body, status: "pending" }]);
      return id;
    },
    settle(id: number, error: Error | null) {
      const current = changes.find((change) => change.id === id);
      if (!current) return;
      const settled = ++clock;
      const paths = new Set(current.body.paths);
      publish(
        changes.flatMap((change) => {
          if (change.id === id)
            return [
              {
                ...change,
                settled,
                status: error ? ("error" as const) : ("success" as const),
                ...(error ? { error, failedPaths: change.body.paths } : {}),
              },
            ];
          if (!error && change.reviewId === current.reviewId && change.id < id && change.status === "error") {
            const failedPaths = change.failedPaths?.filter((path) => !paths.has(path)) ?? [];
            return failedPaths.length ? [{ ...change, failedPaths }] : [];
          }
          return [change];
        }),
      );
    },
    dismiss(id: number) {
      publish(changes.filter((change) => change.id !== id || change.status !== "error"));
    },
    async fetch(reviewId: string, seq: number, signal: AbortSignal, load: () => Promise<RevisionView>) {
      const started = ++clock;
      const result = await load();
      // An aborted/obsolete request must never acknowledge an optimistic entry.
      if (!signal.aborted) completed.set(`${reviewId}:${seq}`, started);
      return result;
    },
  };
}
export function viewedState(client: QueryClient) {
  let store = stores.get(client);
  if (!store) {
    store = createStore(client);
    stores.set(client, store);
  }
  return store;
}
