import { useSyncExternalStore } from "react";

/** What the review showed at the moment the reader pressed Send. */
export interface SendBaseline {
  readonly waited: boolean;
  readonly pickedUpAt: string | null;
  readonly newestRevision: number;
}

export interface HandoffNotice {
  readonly id: number;
  readonly baseline: SendBaseline;
  readonly sentAt: number;
  readonly pickedUp: boolean;
  readonly held: boolean;
  readonly asked: boolean;
  readonly lost: boolean;
}

const notices = new Map<string, HandoffNotice>();
const listeners = new Set<() => void>();
let nextId = 0;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHandoffNotice(reviewId: string) {
  return notices.get(reviewId);
}

export function useHandoffNotice(reviewId: string) {
  return useSyncExternalStore(subscribe, () => getHandoffNotice(reviewId));
}

export function openHandoffNotice(reviewId: string, baseline: SendBaseline) {
  notices.set(reviewId, {
    id: ++nextId,
    baseline,
    sentAt: performance.now(),
    pickedUp: false,
    held: false,
    asked: false,
    lost: false,
  });
  notify();
}

export function markHandoffNotice(
  reviewId: string,
  id: number,
  patch: { pickedUp?: true; held?: true; asked?: boolean; lost?: boolean },
) {
  const entry = notices.get(reviewId);
  if (entry?.id !== id) return;
  const pickedUp = patch.pickedUp ?? entry.pickedUp;
  const held = patch.held ?? entry.held;
  const asked = patch.asked ?? entry.asked;
  const lost = patch.lost ?? entry.lost;
  if (pickedUp === entry.pickedUp && held === entry.held && asked === entry.asked && lost === entry.lost) return;
  notices.set(reviewId, { ...entry, pickedUp, held, asked, lost });
  notify();
}

export function closeHandoffNotice(reviewId: string, id: number) {
  if (notices.get(reviewId)?.id !== id) return;
  notices.delete(reviewId);
  notify();
}

export function resetHandoffNoticesForTests() {
  notices.clear();
  notify();
}
