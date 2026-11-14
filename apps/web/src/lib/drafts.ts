import { Target } from "@emend/contract";

const prefix = "emend.draft.";
const instructionPrefix = "emend.instruction.";
const texts = new Map<string, string | null>();
const saving = new Set<string>();
const reviewSaves = new Map<string, number>();
const sending = new Set<string>();
const listeners = new Set<() => void>();
export type SavedDraft = { key: string; target: Target | null; threadId?: string; commentId?: string };

function notify() {
  for (const listener of listeners) listener();
}
// The store lives for this tab, including when no composer is mounted.
window.addEventListener("storage", (event) => {
  try {
    if (event.storageArea && event.storageArea !== localStorage) return;
  } catch {
    // A localStorage event still supplies its value when storage access is denied.
  }
  if (event.key === null) texts.clear();
  else if (event.key.startsWith(prefix) || event.key.startsWith(instructionPrefix)) {
    texts.set(event.key, event.newValue);
  } else return;
  notify();
});

export function draftKey(reviewId: string, target: Target, threadId?: string) {
  const stable = Object.fromEntries(Object.entries(target).sort(([left], [right]) => left.localeCompare(right)));
  return `emend.draft.${reviewId}.${JSON.stringify(stable)}${threadId ? `.reply.${threadId}` : ""}`;
}
export function editDraftKey(reviewId: string, commentId: string) {
  return `${prefix}${reviewId}.edit.${commentId}`;
}
export function instructionKey(reviewId: string) {
  return `${instructionPrefix}${reviewId}`;
}
export function listDrafts(reviewId: string): SavedDraft[] {
  const drafts: SavedDraft[] = [];
  const reviewPrefix = `${prefix}${reviewId}.`;
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(reviewPrefix)) loadDraft(key);
    }
  } catch {
    /* Storage is optional. */
  }
  for (const [key, body] of texts) {
    if (!key.startsWith(reviewPrefix) || body === null) continue;
    const serialized = key.slice(reviewPrefix.length);
    const edit = /^edit\.([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(serialized);
    if (edit) {
      drafts.push({ key, target: null, commentId: edit[1] });
      continue;
    }
    if (!body) continue;
    const reply = /\.reply\.([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(serialized);
    try {
      const target = Target.parse(JSON.parse(reply ? serialized.slice(0, reply.index) : serialized));
      drafts.push({ key, target, threadId: reply?.[1] });
    } catch {
      drafts.push({ key, target: null });
    }
  }
  return drafts;
}
export function subscribeDrafts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function loadDraft(key: string) {
  if (!texts.has(key)) {
    try {
      const body = localStorage.getItem(key);
      texts.set(key, body);
    } catch {
      /* The in-memory copy remains available without storage. */
    }
  }
  return texts.get(key) ?? "";
}
export function hasDraft(key: string) {
  loadDraft(key);
  return texts.get(key) != null;
}
export function hasDraftText(key: string) {
  return !!loadDraft(key).trim();
}
export function saveDraft(key: string, body: string) {
  texts.set(key, body);
  try {
    localStorage.setItem(key, body);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Storage is optional; the latest text remains in memory. */
    }
  }
  notify();
}
export function clearDraft(key: string) {
  texts.set(key, null);
  try {
    localStorage.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
  notify();
}
export function clearDraftIfUnchanged(key: string, submitted: string) {
  const current = texts.get(key);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    /* The in-memory copy remains available without storage. */
  }
  if (current != null && current !== submitted) {
    saveDraft(key, current);
    return false;
  }
  if (stored != null && stored !== submitted) {
    texts.set(key, stored);
    notify();
    return false;
  }
  clearDraft(key);
  return true;
}
export type UnsavedWork = { saving: boolean; sending: boolean; unstored: boolean };
/**
 * What a reload could lose: a save or a send in flight, or text that only this tab's memory holds
 * because storage could not keep it. Text that localStorage already holds survives a reload.
 */
export function unsavedWork(): UnsavedWork {
  let unstored = false;
  for (const [key, body] of texts) {
    if (!body?.trim()) continue;
    try {
      if (localStorage.getItem(key) === body) continue;
    } catch {
      /* Storage cannot be read, so it cannot be trusted to hold the text. */
    }
    unstored = true;
    break;
  }
  return { saving: saving.size > 0 || reviewSaves.size > 0, sending: sending.size > 0, unstored };
}
export function isDraftSaving(key: string) {
  return saving.has(key);
}
export function isAnyDraftSaving() {
  return saving.size > 0 || reviewSaves.size > 0;
}
export function isReviewDraftSaving(reviewId: string) {
  return (reviewSaves.get(reviewId) ?? 0) > 0;
}
export function isReviewSending(reviewId: string) {
  return sending.has(reviewId);
}
export function beginReviewSend(reviewId: string) {
  if (sending.has(reviewId)) return false;
  sending.add(reviewId);
  notify();
  return true;
}
export function finishReviewSend(reviewId: string) {
  sending.delete(reviewId);
  notify();
}
/** Hold Send through the cache refresh, after the editor's own save has finished. */
export function trackReviewDraftSave(reviewId: string) {
  reviewSaves.set(reviewId, (reviewSaves.get(reviewId) ?? 0) + 1);
  notify();
  return () => {
    const remaining = (reviewSaves.get(reviewId) ?? 1) - 1;
    if (remaining) reviewSaves.set(reviewId, remaining);
    else reviewSaves.delete(reviewId);
    notify();
  };
}
export function beginDraftSave(key: string) {
  if (saving.has(key)) return false;
  saving.add(key);
  notify();
  return true;
}
export function finishDraftSave(key: string) {
  saving.delete(key);
  notify();
}
