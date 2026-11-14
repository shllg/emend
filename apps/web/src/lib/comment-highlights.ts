type Reader = { blocks: Map<string, Range>[]; activeThreadId?: string; openThreadId?: string };
type Card = { threadId: string | null; hovered: boolean; active: boolean; onActivity?: (active: boolean) => void };
const readers = new Set<Reader>();
const cards = new Map<HTMLElement, Card>();
let activeCardThreads = new Set<string>();
const normalName = "emend-comment";
const activeName = "emend-comment-active";

export function supportsCommentHighlights() {
  return (
    typeof CSS !== "undefined" &&
    !!CSS.highlights &&
    typeof Highlight !== "undefined" &&
    typeof Intl !== "undefined" &&
    typeof Intl?.Segmenter === "function"
  );
}

function reconcileCards() {
  const next = new Set<string>();
  for (const [card, state] of cards) {
    const focused = card.contains(card.ownerDocument.activeElement);
    // Chromium can lose :focus-within on slotted ancestors when Pierre replaces
    // the slot, even though the light-DOM descendant retains actual focus.
    if (card.classList.contains("em-card")) card.toggleAttribute("data-focus-within", focused);
    const active = state.hovered || focused;
    if (active && state.threadId !== null) next.add(state.threadId);
    if (active !== state.active) {
      state.active = active;
      state.onActivity?.(active);
    }
  }
  activeCardThreads = next;
}

function activeThreadIds() {
  const ids = new Set(activeCardThreads);
  for (const reader of readers) {
    if (reader.activeThreadId) ids.add(reader.activeThreadId);
    if (reader.openThreadId) ids.add(reader.openThreadId);
  }
  return ids;
}

function clearHighlights() {
  for (const name of [normalName, activeName]) {
    try {
      CSS.highlights.delete(name);
    } catch {
      // Highlight failures must not interrupt reading or comment controls.
    }
  }
}

function rebuild() {
  if (!supportsCommentHighlights()) return;
  // Removing a focused descendant need not dispatch focusout.
  reconcileCards();
  if (!readers.size) {
    clearHighlights();
    return;
  }
  const activeIds = activeThreadIds();
  try {
    const normal = new Highlight();
    const active = new Highlight();
    active.priority = 1;
    for (const reader of readers) {
      for (const block of reader.blocks) {
        try {
          for (const [threadId, range] of block) (activeIds.has(threadId) ? active : normal).add(range);
        } catch {
          // A block is atomic: never leave a partial set of its marks behind.
          for (const range of block.values()) {
            normal.delete(range);
            active.delete(range);
          }
        }
      }
    }
    CSS.highlights.set(normalName, normal);
    CSS.highlights.set(activeName, active);
  } catch {
    clearHighlights();
  }
}

export function registerCommentRanges(blocks: Map<string, Range>[]) {
  if (!supportsCommentHighlights()) return;
  const reader: Reader = { blocks };
  readers.add(reader);
  rebuild();
  return {
    setActiveThread(activeThreadId?: string, openThreadId?: string) {
      if (reader.activeThreadId === activeThreadId && reader.openThreadId === openThreadId) return;
      reader.activeThreadId = activeThreadId;
      reader.openThreadId = openThreadId;
      rebuild();
    },
    unregister() {
      readers.delete(reader);
      rebuild();
    },
  };
}

export function refreshCommentCards() {
  const before = activeThreadIds();
  reconcileCards();
  const after = activeThreadIds();
  if (before.size !== after.size || [...after].some((id) => !before.has(id))) rebuild();
}

/** Each card copy owns its hover/focus state; leaving one cannot clear another. */
export function trackCommentCard(card: HTMLElement, threadId: string | null, onActivity?: (active: boolean) => void) {
  // Every card needs focus styling, including composers without thread highlights
  // or diff-line activity. Null ids still never enter the writeup active set.
  if (!card.classList.contains("em-card") && (threadId === null || !supportsCommentHighlights()) && !onActivity) return;
  const state: Card = { threadId, hovered: false, active: false, onActivity };
  if (!cards.size) document.addEventListener("focusin", refreshCommentCards, true);
  cards.set(card, state);
  const enter = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    state.hovered = true;
    refreshCommentCards();
  };
  const leave = () => {
    state.hovered = false;
    refreshCommentCards();
  };
  const focusOut = (event: FocusEvent) => {
    // A transfer within the card will be reconciled by document focusin.
    if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
    refreshCommentCards();
    // activeElement can still name the departing control during focusout.
    card.removeAttribute("data-focus-within");
  };
  card.addEventListener("pointerenter", enter);
  card.addEventListener("pointerleave", leave);
  card.addEventListener("focusout", focusOut);
  refreshCommentCards();
  return () => {
    card.removeEventListener("pointerenter", enter);
    card.removeEventListener("pointerleave", leave);
    card.removeEventListener("focusout", focusOut);
    cards.delete(card);
    card.removeAttribute("data-focus-within");
    if (state.active) onActivity?.(false);
    if (!cards.size) document.removeEventListener("focusin", refreshCommentCards, true);
    refreshCommentCards();
  };
}
