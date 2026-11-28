import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { reconnectReviewEvents } from "../../lib/event-stream.ts";
import {
  closeHandoffNotice,
  getHandoffNotice,
  type HandoffNotice,
  markHandoffNotice,
} from "../../lib/handoff-notices.ts";
import { shortDate } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { ResumeCommand } from "./ResumeCommand.tsx";

/** What the Send bar knows about the agent, from the review on screen. */
export interface SendAgent {
  agentWaiting: boolean;
  pendingSend: boolean;
  pickedUpAt: string | null;
  releasedAt: string | null;
  /** The review's newest revision. */
  newestRevision: number;
}

/** How long the notice waits for a pick-up before it asks the server again. */
export const HANDOFF_WAIT_MS = 15_000;
/** How long the notice's status line stays empty after it mounts, so a screen reader sees the text arrive. */
export const HANDOFF_ANNOUNCE_MS = 100;
const TOO_SLOW = new Error("The review refetch did not finish in time.");
/** How long the notice's one refetch may take before it counts as a lost connection. */
export const HANDOFF_REFETCH_MS = 3_000;
/** How long the notice stays open after a pick-up. */
export const HANDOFF_CLOSE_MS = 3_000;

function isNetworkFailure(error: unknown): boolean {
  return error === TOO_SLOW || error instanceof TypeError;
}

/** Whether the hand-over note shows: an approved review has nothing left to hand over; a retired one only says when the agent stopped waiting. */
export function showsHandOver(review: { approved: boolean; retired: boolean; releasedAt: string | null }): boolean {
  return !review.approved && (!review.retired || !!review.releasedAt);
}

export function agentStatusText(agent: SendAgent): string {
  if (agent.agentWaiting) return "An agent is waiting";
  const date = agent.releasedAt ? shortDate(agent.releasedAt) : "";
  return date ? `The agent stopped waiting on ${date}` : "No agent waiting";
}

/** The text for a review nobody waits on, or "An agent is waiting" when one does. */
export function handOverText(agent: SendAgent, lifecycle?: { state: string; snoozed: boolean }): string {
  if (agent.agentWaiting) return "An agent is waiting. It gets this now.";
  const date = agent.releasedAt ? shortDate(agent.releasedAt) : "";
  if (!date) return "No agent is waiting. recense keeps this until an agent picks it up.";
  if (lifecycle?.state === "settled") return `The agent stopped waiting when you retired this on ${date}.`;
  if (lifecycle?.snoozed) return `The agent stopped waiting when you snoozed this on ${date}.`;
  return `The agent stopped waiting on ${date}.`;
}

export function ResumeDialog({
  reviewId,
  agent,
  lifecycle,
  open,
  onOpenChange,
  returnFocus,
}: {
  reviewId: string;
  agent: SendAgent;
  lifecycle?: { state: string; snoozed: boolean };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      title="How to resume"
      description={handOverText(agent, lifecycle)}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      actions={
        <Button data-autofocus onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      {!agent.agentWaiting && (
        <div className="mt-3">
          <ResumeCommand reviewId={reviewId} />
        </div>
      )}
    </Dialog>
  );
}

export function HandOverNote({
  reviewId,
  agent,
  lifecycle,
}: {
  reviewId: string;
  agent: SendAgent;
  lifecycle?: { state: string; snoozed: boolean };
}) {
  return (
    <div>
      <p className="m-0 text-fg-3 [font:var(--type-meta)]">{handOverText(agent, lifecycle)}</p>
      {!agent.agentWaiting && <ResumeCommand reviewId={reviewId} compact />}
    </div>
  );
}

/** The notice's buttons keep a 40x40 px hit area on a touch screen at every width. */
const COARSE_TARGET = "[@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:min-w-10";

/**
 * The notice after a Send. "Picked up" means a review snapshot fetched after the Send shows a
 * `pickedUpAt` that is set and differs from the one at Send time, or a newer revision with no Send
 * pending (a Send is never set aside by a new revision, so nothing pending means its delivery was
 * confirmed, even when the agent's publish already cleared `pickedUpAt`). No clocks are compared.
 * Once shown, a pick-up stays shown.
 */
export function SentNotice({
  reviewId,
  entry,
  agent,
  phone,
  returnFocus,
}: {
  reviewId: string;
  entry: HandoffNotice;
  agent: SendAgent;
  phone: boolean;
  returnFocus: () => HTMLElement | null;
}) {
  const client = useQueryClient();
  const notice = useRef<HTMLElement>(null);
  const { id, baseline, sentAt, held, lost } = entry;
  const pickedNow =
    (agent.pickedUpAt !== null && agent.pickedUpAt !== baseline.pickedUpAt) ||
    (agent.newestRevision > baseline.newestRevision && !agent.pendingSend);
  useEffect(() => {
    if (pickedNow) markHandoffNotice(reviewId, id, { pickedUp: true });
  }, [pickedNow, reviewId, id]);
  const pickedUp = entry.pickedUp || pickedNow;
  const deadline = sentAt + HANDOFF_WAIT_MS;
  const [fallback, setFallback] = useState(() => !baseline.waited || performance.now() >= deadline);
  useEffect(() => {
    if (pickedUp || fallback) return;
    const timer = window.setTimeout(() => setFallback(true), Math.max(0, deadline - performance.now()));
    return () => window.clearTimeout(timer);
  }, [pickedUp, fallback, deadline]);
  // A later successful review fetch (from any source) shows the server is reachable again.
  useEffect(() => {
    if (!lost) return;
    return client.getQueryCache().subscribe((event) => {
      const [name, queryReviewId] = event.query.queryKey;
      // A manual write (setQueryData, such as the accepted-Send update) is not a fetch: it proves nothing.
      if (
        name === "review" &&
        queryReviewId === reviewId &&
        event.type === "updated" &&
        event.action.type === "success" &&
        !event.action.manual
      )
        markHandoffNotice(reviewId, id, { lost: false });
    });
  }, [lost, client, reviewId, id]);
  useEffect(() => {
    if (pickedUp || !fallback) return;
    let live = true;
    // Asks once, in the background: the fallback text never waits on it. A reopened stream
    // refetches every query by itself; otherwise this refetches, and a failure or a stall says so.
    const ask = async () => {
      const current = getHandoffNotice(reviewId);
      if (!live || current?.id !== id || current.pickedUp || (current.asked && !current.lost)) return;
      const queryKey = ["review", reviewId];
      const before = client.getQueryState(queryKey);
      markHandoffNotice(reviewId, id, { asked: true });
      // The first ask can finish across visits. A retry belongs to this visit because the next can retry too.
      const stillPending = () => {
        const latest = getHandoffNotice(reviewId);
        return latest?.id === id && !latest.pickedUp && (live || !current.asked);
      };
      let reopened = false;
      try {
        reopened = await reconnectReviewEvents();
      } catch {
        reopened = false;
      }
      if (!stillPending()) return;
      if (reopened) {
        markHandoffNotice(reviewId, id, { lost: false });
        return;
      }
      // Join a refetch already running (the Send's own) instead of cancelling and restarting it.
      const options = { cancelRefetch: false };
      void client.invalidateQueries({ queryKey: ["inbox"] }, options).catch(() => undefined);
      let slow: number | undefined;
      let connectionLost = false;
      try {
        // Only the review decides "cannot reach": a slow inbox says nothing about the server.
        await Promise.race([
          client.invalidateQueries({ queryKey, refetchType: "all" }, { ...options, throwOnError: true }),
          new Promise<never>((_, reject) => {
            slow = window.setTimeout(() => reject(TOO_SLOW), HANDOFF_REFETCH_MS);
          }),
        ]);
      } catch (error) {
        // A network failure or a fetch still unfinished counts; an HTTP error means the server answered.
        connectionLost = isNetworkFailure(error);
      }
      window.clearTimeout(slow);
      if (!stillPending()) return;
      const after = client.getQueryState(queryKey);
      // Two fetches can finish in the same millisecond. Cancellation reverts the counts too.
      const dataAdvanced =
        after &&
        (after.dataUpdatedAt > (before?.dataUpdatedAt ?? 0) || after.dataUpdateCount > (before?.dataUpdateCount ?? 0));
      const serverErrorAdvanced =
        after &&
        !isNetworkFailure(after.error) &&
        (after.errorUpdatedAt > (before?.errorUpdatedAt ?? 0) ||
          after.errorUpdateCount > (before?.errorUpdateCount ?? 0));
      if (connectionLost || after?.fetchStatus === "paused") {
        markHandoffNotice(reviewId, id, { lost: true });
      } else if (dataAdvanced || serverErrorAdvanced) {
        markHandoffNotice(reviewId, id, { lost: false });
      } else if (!current.asked) {
        // A cancelled or removed query gave no answer. The next visit can make the first ask again.
        markHandoffNotice(reviewId, id, { asked: false });
      }
    };
    // A StrictMode cleanup or an immediate unmount can cancel the ask before it starts.
    queueMicrotask(() => void ask());
    return () => {
      live = false;
    };
  }, [pickedUp, fallback, client, reviewId, id]);

  const close = useCallback(() => {
    const restoreFocus = notice.current?.contains(document.activeElement);
    closeHandoffNotice(reviewId, id);
    if (restoreFocus) returnFocus()?.focus({ preventScroll: true });
  }, [reviewId, id, returnFocus]);
  useEffect(() => {
    if (!pickedUp || held) return;
    const timer = window.setTimeout(close, HANDOFF_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [pickedUp, held, close]);

  const hold = useCallback(() => markHandoffNotice(reviewId, id, { held: true }), [reviewId, id]);
  useEffect(() => {
    if (held) return;
    const onSelection = () => {
      const selection = window.getSelection();
      if (selection && notice.current?.contains(selection.anchorNode) && selection.toString() !== "") hold();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [held, hold]);

  // A live region announces text that arrives after it exists, not text it was inserted with.
  // A return to a notice sent a while ago shows its text at once; only a fresh one is announced.
  const [announced, setAnnounced] = useState(() => performance.now() - sentAt >= HANDOFF_ANNOUNCE_MS);
  useEffect(() => {
    if (announced) return;
    const timer = window.setTimeout(() => setAnnounced(true), HANDOFF_ANNOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [announced]);
  const closeButton = useRef<HTMLButtonElement>(null);
  const removedCommandHadFocus = useRef(false);
  const commandRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Ref cleanup runs while the command and its focused control are still in the document.
    return () => {
      removedCommandHadFocus.current = node.contains(document.activeElement);
    };
  }, []);
  const showsCommand = !pickedUp && fallback;
  // A pick-up changes the text, not the height: the reading pane above never shifts for it.
  const [heldHeight, setHeldHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!pickedUp && notice.current) setHeldHeight(notice.current.getBoundingClientRect().height);
  });
  useLayoutEffect(() => {
    if (showsCommand || !removedCommandHadFocus.current) return;
    removedCommandHadFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) closeButton.current?.focus({ preventScroll: true });
  }, [showsCommand]);

  return (
    <section
      aria-label="Sent"
      ref={notice}
      style={pickedUp && heldHeight !== null ? { height: heldHeight } : undefined}
      className="flex max-h-[min(40dvh,max(7rem,calc(100dvh-22rem)))] flex-col border-b border-line-1 bg-sunken px-4 py-2 max-md:py-1"
      onPointerDownCapture={hold}
      onFocusCapture={hold}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else hold();
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h2 className="m-0 text-fg-1 [font:var(--type-h3)]">Sent</h2>
        <Button ref={closeButton} variant="ghost" size={phone ? "lg" : "sm"} className={COARSE_TARGET} onClick={close}>
          Close
        </Button>
      </div>
      <div className="min-h-0 space-y-2 overflow-y-auto pb-1">
        <p role="status" className="m-0 min-h-lh text-fg-2 [font:var(--type-body)]">
          {!announced
            ? ""
            : pickedUp
              ? "The agent picked up your feedback."
              : fallback
                ? lost
                  ? "recense cannot reach its server right now, so a pick-up may not show here. If no agent has it yet, hand it over with the command below."
                  : "No agent has picked this up yet. recense keeps it until one does."
                : "Waiting for the agent to pick this up…"}
        </p>
        {showsCommand && (
          <div ref={commandRef}>
            <ResumeCommand reviewId={reviewId} buttonSize={phone ? "lg" : "sm"} buttonClassName={COARSE_TARGET} />
          </div>
        )}
      </div>
    </section>
  );
}
