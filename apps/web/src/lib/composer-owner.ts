import type { Target } from "@emend/contract";
import { createContext, useContext, useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { DiffNavigation } from "./diff-navigation.ts";
import { hasDraft, hasDraftText, isDraftSaving, subscribeDrafts } from "./drafts.ts";

type Claim = { surface: string; id?: string; pendingFocus?: HTMLTextAreaElement; focusCancelled?: boolean };
type Entry = {
  members: Map<string, string>;
  cards: Set<string>;
  replyOpen?: boolean;
  release?: object;
  claim?: Claim;
  handoff?: Claim;
};
const entries = new Map<string, Entry>();
const edits = new Map<string, { dismissed: boolean; cards: Set<string> }>();
// Source chunks retain visibility while their cards are virtualized. Other surfaces
// keep their usual draft-based restoration when the last copy unmounts.
export const ComposerVisibilityContext = createContext<Map<string, boolean> | null>(null);
const listeners = new Set<() => void>();
let version = 0;
function notify() {
  version++;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  if (!listeners.size) document.addEventListener("focusin", onFocusIntent);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) document.removeEventListener("focusin", onFocusIntent);
  };
}
const snapshot = () => version;
function entry(key: string) {
  let value = entries.get(key);
  if (!value) {
    value = { members: new Map(), cards: new Set() };
    entries.set(key, value);
  }
  return value;
}
function cancelHandoffs() {
  let changed = false;
  for (const [key, value] of entries) {
    if (!value.handoff) continue;
    if (value.claim === value.handoff) value.claim = undefined;
    value.handoff = undefined;
    if (!value.cards.size && !value.members.size && !value.claim && !value.release) entries.delete(key);
    changed = true;
  }
  if (changed) notify();
}
/** Renew the returning editor's deferred focus and supersede the others; drafts stay intact. */
function updatePendingFocus(intent?: string | EventTarget | null) {
  let changed = false;
  for (const [key, { claim }] of entries) {
    if (!claim?.pendingFocus) continue;
    const cancelled = key !== intent && claim.pendingFocus !== intent;
    if (!!claim.focusCancelled === cancelled) continue;
    // Keep the editor identity so its own later focusin can renew this request.
    claim.focusCancelled = cancelled;
    changed = true;
  }
  if (changed) notify();
}
function onFocusIntent(event: FocusEvent) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    updatePendingFocus(event.target);
}
/** An intent may arrive before its surface mounts (navigation or a lazy pane). */
export function claimDraft(key: string, surface: string) {
  const edit = edits.get(key);
  if (edit) edit.dismissed = false;
  updatePendingFocus();
  cancelHandoffs();
  const value = entry(key);
  value.release = undefined;
  value.claim = { surface };
  value.replyOpen = true;
  notify();
}
function closeReply(key: string) {
  const value = entries.get(key);
  if (!value || value.replyOpen === false) return;
  value.replyOpen = false;
  value.claim = undefined;
  value.handoff = undefined;
  notify();
}
/** Cards share visibility; ownership still selects the one editable copy. */
export function useReplyComposer(key: string, enabled = true) {
  const id = useId();
  const visibility = useContext(ComposerVisibilityContext);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const value = entries.get(key);
  const open = value?.replyOpen ?? visibility?.get(key) ?? hasDraftText(key);
  useLayoutEffect(() => {
    if (!enabled) return;
    const value = entry(key);
    value.release = undefined;
    value.cards.add(id);
    value.replyOpen ??= visibility?.get(key) ?? hasDraftText(key);
    notify();
    // Close every copy as soon as a successful save clears its draft, even if
    // query refreshes unmount the submitting composer before its onSaved runs.
    const unsubscribe = subscribeDrafts(() => {
      if (isDraftSaving(key) && !hasDraft(key)) closeReply(key);
    });
    return () => {
      unsubscribe();
      if (value.replyOpen !== undefined) visibility?.set(key, value.replyOpen);
      value.cards.delete(id);
      if (!value.cards.size) {
        // A card may move from a loading fallback into its inline slot in this
        // commit. Preserve explicit opening, including a reply with no text.
        const release = {};
        value.release = release;
        queueMicrotask(() => {
          if (value.release !== release) return;
          value.release = undefined;
          value.replyOpen = undefined;
          if (!value.members.size && !value.claim && !value.handoff && entries.get(key) === value) entries.delete(key);
          notify();
        });
      }
      notify();
    };
  }, [key, id, visibility, enabled]);
  return { open, close: () => closeReply(key) };
}
export function isEditComposerOpen(key: string) {
  return !edits.get(key)?.dismissed;
}
/** Dismissing an edit hides every copy without changing its draft or ownership handoff. */
export function useEditComposer(key: string) {
  const id = useId();
  const visibility = useContext(ComposerVisibilityContext);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const edit = edits.get(key);
  const open = edit ? !edit.dismissed : entries.get(key)?.claim ? true : (visibility?.get(key) ?? true);
  useLayoutEffect(() => {
    const edit = edits.get(key) ?? {
      dismissed: !entries.get(key)?.claim && visibility?.get(key) === false,
      cards: new Set<string>(),
    };
    edits.set(key, edit);
    edit.cards.add(id);
    return () => {
      visibility?.set(key, !edit.dismissed);
      edit.cards.delete(id);
      if (!edit.cards.size) edits.delete(key);
    };
  }, [key, id, visibility]);
  return {
    open,
    close: () => {
      const edit = edits.get(key);
      if (edit) edit.dismissed = true;
      notify();
    },
  };
}
/** Closed cards must see intents even before they have mounted an editor. */
export function useDraftClaim(keys: string | string[], surface: string) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  // A fulfilled claim (including a focused editor's handoff) must not reopen a
  // card whose saved draft has just disappeared during a revision refresh.
  return (typeof keys === "string" ? [keys] : keys)
    .map((key) => entries.get(key)?.claim)
    .find((claim) => claim?.surface === surface && !claim.id);
}
export function useComposerOwner(key: string, surface: string, target: Target, threadId?: string, commentId?: string) {
  const navigateDiff = useContext(DiffNavigation);
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const focused = useRef<Claim | undefined>(undefined);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useLayoutEffect(() => {
    const value = entry(key);
    value.members.set(id, surface);
    if (value.handoff) {
      value.claim = { surface, id };
      value.handoff = undefined;
    }
    notify();
    return () => {
      value.members.delete(id);
      if (value.claim?.id === id) {
        if (input.current && document.activeElement === input.current) {
          // Keep a focused claim through the replacement's commit, then release it
          // if no editor mounted. Existing copies do not steal a pending move.
          const handoff = value.claim;
          value.handoff = handoff;
          setTimeout(() => {
            if (value.handoff !== handoff) return;
            value.handoff = undefined;
            if (value.claim === handoff) value.claim = undefined;
            if (!value.cards.size && !value.members.size && !value.release && entries.get(key) === value)
              entries.delete(key);
            notify();
          }, 0);
        } else value.claim = undefined;
      }
      if (
        !value.cards.size &&
        !value.release &&
        !value.handoff &&
        !value.members.size &&
        (!value.claim || value.claim.surface === surface)
      )
        entries.delete(key);
      notify();
    };
  }, [key, surface, id]);
  const value = entries.get(key);
  const request = value?.claim;
  // An unclaimed sole copy can be edited. Multiple copies wait for an explicit act.
  const owns = request
    ? request.id
      ? request.id === id
      : request.surface === surface &&
        [...(value?.members.values() ?? [])].filter((member) => member === surface).length <= 1
    : (value?.members.size ?? 0) <= 1;
  const claim = () => {
    updatePendingFocus(key);
    cancelHandoffs();
    if (value?.claim?.id === id || (owns && value?.claim?.surface === surface)) return;
    const next = entry(key);
    next.claim = { surface, id };
    notify();
  };
  useLayoutEffect(() => {
    // Returning focus must recognize the owning replacement even while its request is canceled.
    if (owns && request?.pendingFocus && input.current) request.pendingFocus = input.current;
    if (!owns || !request || request.focusCancelled || focused.current === request || !input.current) return;
    const editor = input.current.closest<HTMLElement>(".em-composer");
    if (
      surface === "diff" &&
      navigateDiff &&
      !navigateDiff({
        target,
        elementId: threadId ? `diff-thread-${threadId}` : undefined,
        commentId,
        element: editor ?? undefined,
      })
    ) {
      request.pendingFocus = input.current;
      return;
    }
    if (surface === "diff" && input.current.closest("[hidden]")) return;
    request.pendingFocus = undefined;
    // A fulfilled surface intent belongs to this instance and ends when it unmounts.
    if (!request.id) {
      request.id = id;
      notify();
    }
    focused.current = request;
    if (surface !== "diff" || !navigateDiff) {
      const anchor = input.current.closest<HTMLElement>("[data-thread-card], [data-diff-section]");
      if (anchor) anchor.scrollIntoView?.({ block: "center" });
      else editor?.scrollIntoView?.({ block: "nearest" });
    }
    input.current.focus({ preventScroll: true });
  });
  return { owns, claim, input };
}
