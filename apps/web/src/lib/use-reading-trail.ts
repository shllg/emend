import { type ParsedLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { ReadingAnchor } from "./reading-position.ts";

export type ReadingEntry = {
  title: string;
  revision: number;
  folds: Map<string, boolean>;
  positions: Map<string, ReadingAnchor | null>;
  focus?: { id: string; children: number[] };
};

/** Only entries observed inside this review can supply a Back label. Browser Back uses the same history. */
export function useReadingTrail(title: string, revision: number, location: ParsedLocation) {
  const router = useRouter();
  const index = location.state.__TSR_index;
  const trail = useRef(new Map<number, ReadingEntry>());
  let entry = trail.current.get(index);
  const known = !!entry && entry.revision === revision;
  const visit = useRef({ key: location.state.__TSR_key, index, returning: false });
  if (visit.current.key !== location.state.__TSR_key)
    visit.current = { key: location.state.__TSR_key, index, returning: known && index !== visit.current.index };
  if (!entry || entry.revision !== revision) {
    const prior = trail.current.get(index - 1);
    entry = { title, revision, folds: new Map(prior?.revision === revision ? prior.folds : []), positions: new Map() };
    trail.current.set(index, entry);
  }
  entry.title = title;
  const previous = trail.current.get(index - 1);
  useEffect(
    () =>
      router.history.subscribe(({ action, location }) => {
        if (action.type === "PUSH") {
          for (const key of trail.current.keys()) if (key >= location.state.__TSR_index) trail.current.delete(key);
        }
      }),
    [router],
  );
  return {
    entry,
    returning: visit.current.returning,
    back: previous ? { title: previous.title, go: () => router.history.back() } : undefined,
  };
}
