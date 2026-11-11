import {
  APPROVED_ACTIVE_HOURS,
  type InboxItem,
  type RetireRequest,
  type ReviewView,
  type RevisionView,
  type SnoozeRequest,
  type ViewedRequest,
} from "@emend/contract";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import {
  beginDraftSave,
  clearDraft,
  clearDraftIfUnchanged,
  finishDraftSave,
  isDraftSaving,
  subscribeDrafts,
  trackReviewDraftSave,
} from "../lib/drafts.ts";
import { refreshQueries } from "../lib/query-refresh.ts";
import { viewedState } from "../lib/viewed-state.ts";
import { ApiError, change } from "./client.ts";
import { type InboxData, serverNow } from "./queries.ts";

function applyViewed(view: RevisionView, body: ViewedRequest): RevisionView {
  if (view.seq !== body.revision) return view;
  const paths = new Set(body.paths);
  return {
    ...view,
    files: view.files.map((file) => {
      if (file.role !== "diff" || !paths.has(file.path)) return file;
      const { viewed: _viewed, viewedOn: _viewedOn, ...rest } = file;
      return body.viewed ? { ...rest, viewed: "viewed", viewedOn: body.revision } : rest;
    }),
  };
}

// Session state outlives mounted mutation observers, including failures awaiting dismissal.
export function useViewedChanges(reviewId: string) {
  const store = viewedState(useQueryClient());
  const changes = useSyncExternalStore(store.subscribe, store.snapshot);
  return useMemo(() => changes.filter((change) => change.reviewId === reviewId), [changes, reviewId]);
}
export function useViewedErrors(reviewId: string) {
  const store = viewedState(useQueryClient());
  const changes = useViewedChanges(reviewId);
  return { errors: changes.filter((change) => change.status === "error"), dismiss: store.dismiss };
}
export function useViewedRevision(reviewId: string, view: RevisionView | undefined) {
  const changes = useViewedChanges(reviewId);
  return useMemo(
    () =>
      view &&
      changes.reduce(
        (current, change) => (change.status !== "error" ? applyViewed(current, change.body) : current),
        view,
      ),
    [view, changes],
  );
}
export function useViewedMutation(reviewId: string) {
  const client = useQueryClient();
  const store = viewedState(client);
  return useMutation({
    scope: { id: `viewed:${reviewId}` },
    mutationFn: (body: ViewedRequest) => change(`/api/v1/reviews/${encodeURIComponent(reviewId)}/viewed`, "PUT", body),
    onMutate: (body) => store.start(reviewId, body),
    onSettled: (_data, error, _body, id) => {
      if (id !== undefined) store.settle(id, error);
      refreshQueries(client, [["revision", reviewId]], { settled: true });
    },
  });
}

export function mutationMessage(error: Error) {
  return error instanceof ApiError && error.code === "stale_revision"
    ? "This page is out of date. Reload to see the newest revision."
    : error instanceof ApiError
      ? error.message
      : "The request failed. Try again.";
}
export type LifecycleAction =
  | { action: "snooze"; body: SnoozeRequest }
  | { action: "unsnooze" }
  | { action: "retire"; body: RetireRequest }
  | { action: "reopen" }
  | { action: "delete" };

/** Snooze, unsnooze, retire, reopen and delete. The server's own message reaches the caller as an ApiError. */
export function useLifecycleMutation(reviewId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: LifecycleAction) => {
      const path = `/api/v1/reviews/${encodeURIComponent(reviewId)}`;
      if (input.action === "delete") {
        await change(path, "DELETE");
        // No wait: the page navigates away first, and a refetch of this review would answer 404.
        void client.invalidateQueries({ queryKey: ["inbox"] });
        return;
      }
      await change(`${path}/${input.action}`, "POST", "body" in input ? input.body : undefined);
      // The caller closes its dialog when the server answers; the refetch lands after.
      if (input.action === "retire") void client.invalidateQueries({ queryKey: ["revision", reviewId] });
      void client.invalidateQueries({ queryKey: ["review", reviewId] });
      void client.invalidateQueries({ queryKey: ["inbox"] });
    },
    onError: (error) => {
      // Unsent comments appeared elsewhere: refetch so the dialog can name the new count.
      if (error instanceof ApiError && error.code === "unsent_comments") {
        void client.invalidateQueries({ queryKey: ["revision", reviewId] });
        void client.invalidateQueries({ queryKey: ["review", reviewId] });
        void client.invalidateQueries({ queryKey: ["inbox"] });
      }
    },
  });
}

type Accepted = { kind: "send" | "approve"; revision?: number };

/** Shows an accepted Send or Approve in the cached review, inbox and revisions before the refetch lands. */
function applyAccepted(client: QueryClient, reviewId: string, { kind, revision }: Accepted) {
  const estimate = serverNow(client.getQueryData<InboxData>(["inbox"]));
  const activeUntil = new Date(estimate + APPROVED_ACTIVE_HOURS * 3_600_000).toISOString();
  const change = <T extends InboxItem>(item: T): T =>
    kind === "approve"
      ? { ...item, state: "approved", list: "active", snoozed: false, snoozedUntil: null, activeUntil }
      : { ...item, unsentCount: 0, pendingSend: true };
  // Only a loaded item changes; anything else in the cache is left to the refetch.
  client.setQueryData<ReviewView>(["review", reviewId], (view) => (view?.id === reviewId ? change(view) : view));
  client.setQueryData<InboxData>(["inbox"], (list) =>
    Array.isArray(list?.items)
      ? { ...list, items: list.items.map((item) => (item.id === reviewId ? change(item) : item)) }
      : list,
  );
  if (kind === "send" && revision !== undefined) {
    client.setQueriesData<RevisionView>({ queryKey: ["revision", reviewId] }, (view) =>
      view
        ? {
            ...view,
            threads: view.threads.map((thread) =>
              thread.comments.some((comment) => comment.author === "user" && comment.sent === false)
                ? {
                    ...thread,
                    state: "sent",
                    comments: thread.comments.map((comment) =>
                      comment.author === "user" && comment.sent === false
                        ? { ...comment, sent: true, sentOn: revision }
                        : comment,
                    ),
                  }
                : thread,
            ),
          }
        : view,
    );
  }
}

export function useReviewMutation(reviewId: string, key?: string) {
  const client = useQueryClient();
  const pending = useSyncExternalStore(subscribeDrafts, () => (key ? isDraftSaving(key) : false));
  const mutation = useMutation({
    mutationFn: async ({
      path,
      method = "POST",
      body,
      draft,
      deleteDraft,
      refresh = "await",
      accepted,
    }: {
      path: string;
      method?: "POST" | "PATCH" | "DELETE";
      body?: unknown;
      draft?: { key: string; text: string };
      deleteDraft?: string;
      /**
       * "background" resolves when the server answers and refetches without waiting, so a stalled
       * network cannot keep the caller busy (Send, Approve). The default waits for the refetch: a
       * saved comment must show in the unsent count before the Send bar judges it.
       */
      refresh?: "await" | "background";
      /**
       * What the server did when it accepted this write: the cached review, inbox and revisions show it
       * at once, the way the server will, until the refetch corrects them. This closes the gap in
       * which a second Send or Approve would still look possible.
       */
      accepted?: Accepted;
    }) => {
      if (draft && !beginDraftSave(draft.key)) throw new Error("This draft is already saving.");
      const finishReviewSave = draft || deleteDraft ? trackReviewDraftSave(reviewId) : undefined;
      try {
        let result: unknown;
        try {
          try {
            result = await change(path, method, body);
          } catch (error) {
            // A refused write usually means the bar was stale (empty_send, stale_revision): heal it.
            if (refresh === "background") {
              void client.invalidateQueries({ queryKey: ["revision", reviewId] }).catch(() => undefined);
              void client.invalidateQueries({ queryKey: ["review", reviewId] }).catch(() => undefined);
              void client.invalidateQueries({ queryKey: ["inbox"] }).catch(() => undefined);
            }
            throw error;
          }
          // Invalidation reuses a pending first revision fetch, which could restore pre-Send counts.
          if (accepted?.kind === "send") await client.cancelQueries({ queryKey: ["revision", reviewId] });
          if (accepted) applyAccepted(client, reviewId, accepted);
          if (draft) clearDraftIfUnchanged(draft.key, draft.text);
          if (deleteDraft) clearDraft(deleteDraft);
        } finally {
          if (draft) finishDraftSave(draft.key);
        }
        const refetched = Promise.all([
          client.invalidateQueries({ queryKey: ["revision", reviewId] }),
          client.invalidateQueries({ queryKey: ["review", reviewId] }),
          client.invalidateQueries({ queryKey: ["inbox"] }),
        ]);
        if (refresh === "background") void refetched.catch(() => undefined);
        else await refetched;
        return result;
      } finally {
        finishReviewSave?.();
      }
    },
  });
  return { ...mutation, isPending: pending || mutation.isPending };
}
