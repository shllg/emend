import type { RevisionView } from "@emend/contract";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type SetStateAction, useEffect, useMemo, useState } from "react";
import { useViewedChanges } from "../api/mutations.ts";
import { useReadOnlyReview } from "./read-only-review.ts";

type Folds = {
  review: string;
  seq: number;
  changes: ReturnType<typeof useViewedChanges>;
  seen: Set<number>;
  folded: Set<string>;
  pending: Map<number, Set<string>>;
};
/** In memory, per session: the phone unmounts the Diff tab, but a reader's folds outlive it. */
const kept = new WeakMap<QueryClient, Map<string, Folds>>();

/** Server refetches update marks, never the reader's current fold choices. */
export function useViewedCollapse(reviewId: string, revision: RevisionView) {
  const changes = useViewedChanges(reviewId);
  const readOnly = useReadOnlyReview();
  const client = useQueryClient();
  const initial = (): Folds => {
    const server = client.getQueryData<RevisionView>(["revision", reviewId, revision.seq]) ?? revision;
    const folded = new Set(server.files.filter((file) => file.viewed === "viewed").map((file) => file.id));
    const pending = new Map<number, Set<string>>();
    for (const change of changes) {
      if (change.body.revision !== revision.seq || change.status === "error") continue;
      const paths = new Set(change.body.paths);
      const ids = revision.files.filter((file) => file.role === "diff" && paths.has(file.path)).map((file) => file.id);
      if (!change.body.viewed) {
        // Unmarking Viewed expands the file again.
        for (const id of ids) {
          folded.delete(id);
          for (const files of pending.values()) files.delete(id);
        }
        continue;
      }
      if (change.status === "pending") pending.set(change.id, new Set(ids));
      else for (const id of ids) folded.add(id);
    }
    return {
      review: reviewId,
      seq: revision.seq,
      changes,
      seen: new Set(changes.map((change) => change.id)),
      folded,
      pending,
    };
  };
  const [state, setState] = useState(() => kept.get(client)?.get(reviewId) ?? initial());
  useEffect(() => {
    if (readOnly) return;
    const reviews = kept.get(client) ?? new Map<string, Folds>();
    reviews.set(state.review, state);
    kept.set(client, reviews);
  }, [readOnly, client, state]);
  if (state.seq !== revision.seq || state.review !== reviewId) setState(initial());
  else if (state.changes !== changes) {
    const next = {
      ...state,
      changes,
      seen: new Set(state.seen),
      folded: new Set(state.folded),
      // Copy each inner Set: unmarks delete from them, and the previous state keeps its own.
      pending: new Map([...state.pending].map(([id, files]) => [id, new Set(files)])),
    };
    for (const change of changes) {
      if (!next.seen.has(change.id)) {
        next.seen.add(change.id);
        if (change.status !== "error" && change.body.revision === revision.seq) {
          const paths = new Set(change.body.paths);
          const ids = revision.files
            .filter((file) => file.role === "diff" && paths.has(file.path))
            .map((file) => file.id);
          if (change.body.viewed) next.pending.set(change.id, new Set(ids));
          else {
            // Unmarking Viewed expands the file again.
            for (const id of ids) {
              next.folded.delete(id);
              for (const files of next.pending.values()) files.delete(id);
            }
          }
        }
      }
      const files = next.pending.get(change.id);
      if (files && change.status !== "pending") {
        if (change.status === "success") for (const id of files) next.folded.add(id);
        next.pending.delete(change.id);
      }
    }
    // Confirmed successes leave the overlay after the fetch commits to the cache.
    const remaining = new Set(changes.map((change) => change.id));
    for (const [id, files] of next.pending)
      if (!remaining.has(id)) {
        for (const file of files) next.folded.add(file);
        next.pending.delete(id);
      }
    setState(next);
  }
  const collapsed = (value: typeof state) =>
    new Set([...value.folded, ...[...value.pending.values()].flatMap((files) => [...files])]);
  const changeCollapsed = (action: SetStateAction<Set<string>>) =>
    setState((previous) => {
      const before = collapsed(previous);
      const after = typeof action === "function" ? action(before) : action;
      const folded = new Set(previous.folded);
      const pending = new Map([...previous.pending].map(([id, files]) => [id, new Set(files)]));
      for (const id of new Set([...before, ...after])) {
        if (before.has(id) === after.has(id)) continue;
        if (after.has(id)) folded.add(id);
        else folded.delete(id);
        // A manual fold or navigation supersedes any pending automatic fold.
        for (const files of pending.values()) files.delete(id);
      }
      return { ...previous, folded, pending };
    });
  const files = useMemo(
    () => new Set([...state.folded, ...[...state.pending.values()].flatMap((files) => [...files])]),
    [state.folded, state.pending],
  );
  return [files, changeCollapsed] as const;
}
