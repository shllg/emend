import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { reconnectReviewEvents } from "../../lib/event-stream.ts";
import { shortDate } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Sheet } from "../ui/Sheet.tsx";
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

/** What the review showed at the moment the reader pressed Send. */
export interface SendBaseline {
  waited: boolean;
  pickedUpAt: string | null;
  newestRevision: number;
}

/** How long the window waits for a pick-up before it asks the server again. */
export const HANDOFF_WAIT_MS = 15_000;
const TOO_SLOW = new Error("The review refetch did not finish in time.");
/** How long the window's one refetch may take before it counts as a lost connection. */
export const HANDOFF_REFETCH_MS = 3_000;
/** How long the window stays open after a pick-up. */
export const HANDOFF_CLOSE_MS = 3_000;

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

/**
 * The window after a Send. "Picked up" means a review snapshot fetched after the Send shows a
 * `pickedUpAt` that is set and differs from the one at Send time, or a newer revision with no Send
 * pending (a Send is never set aside by a new revision, so nothing pending means its delivery was
 * confirmed, even when the agent's publish already cleared `pickedUpAt`). No clocks are compared.
 * Once shown, a pick-up stays shown.
 */
export function HandoffWindow({
  reviewId,
  baseline,
  agent,
  phone,
  onClose,
  returnFocus,
  returnFocusPhone,
}: {
  reviewId: string;
  baseline: SendBaseline;
  /** The review's agent data now. */
  agent: SendAgent;
  phone: boolean;
  onClose: () => void;
  /** Desktop: the element that gets focus back (the Send button is disabled after a Send). */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Phone: the element that gets focus back. */
  returnFocusPhone?: () => HTMLElement | null;
}) {
  const client = useQueryClient();
  const { waited } = baseline;
  const pickedNow =
    (agent.pickedUpAt !== null && agent.pickedUpAt !== baseline.pickedUpAt) ||
    (agent.newestRevision > baseline.newestRevision && !agent.pendingSend);
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (pickedNow) setLatched(true);
  }, [pickedNow]);
  const pickedUp = latched || pickedNow;
  const [fallback, setFallback] = useState(!waited);
  // Once the reader touches the window (pointer, key, selection) it stays until they close it.
  const [held, setHeld] = useState(false);
  const status = useRef<HTMLSpanElement>(null);
  // True once the window could not reach the server: the stream did not reopen and the refetch
  // failed or did not settle in time. A pick-up may then exist without showing here.
  const [lost, setLost] = useState(false);
  // A later successful review fetch (from any source) shows the server is reachable again.
  useEffect(() => {
    if (!lost) return;
    return client.getQueryCache().subscribe((event) => {
      const [name, id] = event.query.queryKey;
      // A manual write (setQueryData, such as the accepted-Send update) is not a fetch: it proves nothing.
      if (
        name === "review" &&
        id === reviewId &&
        event.type === "updated" &&
        event.action.type === "success" &&
        !event.action.manual
      )
        setLost(false);
    });
  }, [lost, client, reviewId]);
  useEffect(() => {
    if (pickedUp) return;
    let live = true;
    let slow: number | undefined;
    // Asks once, in the background: the fallback text never waits on it. A reopened stream
    // refetches every query by itself; otherwise this refetches, and a failure or a stall says so.
    const ask = async () => {
      let reopened = false;
      try {
        reopened = await reconnectReviewEvents();
      } catch {
        reopened = false;
      }
      if (reopened || !live) return;
      // Join a refetch already running (the Send's own) instead of cancelling and restarting it.
      const options = { cancelRefetch: false };
      void client.invalidateQueries({ queryKey: ["inbox"] }, options).catch(() => undefined);
      try {
        // Only the review decides "cannot reach": a slow inbox says nothing about the server.
        await Promise.race([
          client.invalidateQueries({ queryKey: ["review", reviewId] }, { ...options, throwOnError: true }),
          new Promise<never>((_, reject) => {
            slow = window.setTimeout(() => reject(TOO_SLOW), HANDOFF_REFETCH_MS);
          }),
        ]);
      } catch (error) {
        // A network failure or a fetch still unfinished counts; an HTTP error means the server answered.
        if (live && (error === TOO_SLOW || error instanceof TypeError)) setLost(true);
      }
      window.clearTimeout(slow);
    };
    // The stream may be dead after a suspend: ask once, and give the reader the way to hand over.
    if (!waited) {
      void ask();
      return () => {
        live = false;
        window.clearTimeout(slow);
      };
    }
    const timer = window.setTimeout(() => {
      setFallback(true);
      void ask();
    }, HANDOFF_WAIT_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.clearTimeout(slow);
    };
  }, [pickedUp, waited, client, reviewId]);
  useEffect(() => {
    if (!pickedUp || held) return;
    const timer = window.setTimeout(onClose, HANDOFF_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [pickedUp, held, onClose]);
  useEffect(() => {
    const onSelection = () => {
      const selection = window.getSelection();
      const dialog = status.current?.closest('[role="alertdialog"], [role="dialog"]');
      if (selection && selection.toString() !== "" && selection.anchorNode && dialog?.contains(selection.anchorNode))
        setHeld(true);
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);
  const text = (
    <span role="status" ref={status}>
      {pickedUp
        ? "The agent picked up your feedback."
        : fallback
          ? lost
            ? "recense cannot reach its server right now, so a pick-up may not show here. If no agent has it yet, hand it over with the command below."
            : "No agent has picked this up yet. recense keeps it until one does."
          : "Waiting for the agent to pick this up…"}
    </span>
  );
  const command = !pickedUp && fallback && <ResumeCommand reviewId={reviewId} />;
  const change = (open: boolean) => {
    if (!open) onClose();
  };
  const touched = () => setHeld(true);
  return (
    // The wrapper only listens: React bubbles events from the portaled window to it.
    <div className="contents" onPointerDownCapture={touched} onKeyDownCapture={touched}>
      {phone ? (
        <Sheet side="bottom" title="Sent" description={text} open onOpenChange={change} returnFocus={returnFocusPhone}>
          {command}
        </Sheet>
      ) : (
        <Dialog
          title="Sent"
          description={text}
          open
          onOpenChange={change}
          returnFocus={returnFocus}
          preferReturnFocus
          actions={
            <Button data-autofocus onClick={onClose}>
              Close
            </Button>
          }
        >
          {command ? <div className="mt-3">{command}</div> : null}
        </Dialog>
      )}
    </div>
  );
}
