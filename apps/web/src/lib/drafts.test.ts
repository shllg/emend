import { afterEach, beforeEach, expect, test, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("./drafts.ts");
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("nothing in flight and nothing typed is no unsaved work", async () => {
  const drafts = await load();
  expect(drafts.unsavedWork()).toEqual({ saving: false, sending: false, unstored: false });
});

test("text that localStorage keeps survives a reload and does not count", async () => {
  const drafts = await load();
  drafts.saveDraft("recense.draft.review.synthetic", "kept");
  expect(localStorage.getItem("recense.draft.review.synthetic")).toBe("kept");
  expect(drafts.unsavedWork().unstored).toBe(false);
  drafts.clearDraft("recense.draft.review.synthetic");
  expect(drafts.unsavedWork().unstored).toBe(false);
});

test("text that only memory holds counts, until it is cleared or blank", async () => {
  const drafts = await load();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  });
  drafts.saveDraft("recense.draft.review.synthetic", "lost on reload");
  expect(drafts.unsavedWork().unstored).toBe(true);
  drafts.saveDraft("recense.draft.review.synthetic", "  ");
  expect(drafts.unsavedWork().unstored).toBe(false);
  drafts.saveDraft("recense.draft.review.synthetic", "again");
  expect(drafts.unsavedWork().unstored).toBe(true);
  drafts.clearDraft("recense.draft.review.synthetic");
  expect(drafts.unsavedWork().unstored).toBe(false);
});

test("text counts when storage cannot be read back", async () => {
  const drafts = await load();
  drafts.saveDraft("recense.draft.review.synthetic", "kept");
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("denied");
    },
  });
  expect(drafts.unsavedWork().unstored).toBe(true);
});

test("a draft save, a review save and a send in flight each count", async () => {
  const drafts = await load();
  expect(drafts.beginDraftSave("recense.draft.review.synthetic")).toBe(true);
  expect(drafts.unsavedWork()).toMatchObject({ saving: true, sending: false });
  drafts.finishDraftSave("recense.draft.review.synthetic");
  expect(drafts.unsavedWork().saving).toBe(false);
  const done = drafts.trackReviewDraftSave("review");
  expect(drafts.unsavedWork().saving).toBe(true);
  done();
  expect(drafts.unsavedWork().saving).toBe(false);
  expect(drafts.beginReviewSend("review")).toBe(true);
  expect(drafts.unsavedWork()).toMatchObject({ saving: false, sending: true });
  drafts.finishReviewSend("review");
  expect(drafts.unsavedWork().sending).toBe(false);
});
